// react-pdf only toggles the `selecting` class on mousedown/mouseup inside a single
// text layer. pdf.js' own viewer does more: while a selection is live it parks the
// `.endOfContent` guard element right next to the edge being dragged, so a pointer
// resting in a gap between words/lines does not make the selection jump across the
// page. The first half of this file is a port of that logic (TextLayerBuilder in
// pdfjs-dist/web/pdf_viewer.mjs) for layers rendered by react-pdf.
//
// pdf.js' guard alone freezes the selection while the pointer is over empty space.
// Native readers instead extend to the nearest line, so the second half snaps the
// selection focus to the closest text when the pointer is not over any text span,
// and also lets a drag start from empty space.

const SPAN_SELECTOR = 'span[role="presentation"]';
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_MAX_STEP = 28;

type TextPosition = { node: Node; offset: number };
type Point = { x: number; y: number };

const endDivs = new WeakMap<HTMLElement, HTMLElement>();

function getEndDiv(layer: HTMLElement): HTMLElement | null {
  const cached = endDivs.get(layer);
  if (cached && layer.contains(cached)) return cached;

  const found = layer.querySelector<HTMLElement>('.endOfContent');
  if (found) endDivs.set(layer, found);
  return found;
}

function resetLayer(layer: HTMLElement): void {
  const end = getEndDiv(layer);

  if (end && (end.parentNode !== layer || end.style.width || end.style.height || end.style.userSelect)) {
    layer.append(end);
    end.style.width = '';
    end.style.height = '';
    end.style.userSelect = '';
  }

  layer.classList.remove('selecting');
}

function getTextLayers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.textLayer'));
}

function toElement(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function caretFromPoint(x: number, y: number): TextPosition | null {
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  const position = document.caretPositionFromPoint?.(x, y);
  return position ? { node: position.offsetNode, offset: position.offset } : null;
}

// Closest text position in `layer` to a point that is not over any text span.
// Closest line wins (vertical distance first), then closest span on that line.
function nearestTextPosition(layer: HTMLElement, point: Point): TextPosition | null {
  let best: { span: HTMLElement; rect: DOMRect; dy: number; dx: number } | null = null;

  for (const span of layer.querySelectorAll<HTMLElement>(SPAN_SELECTOR)) {
    if (!span.firstChild) continue;

    const rect = span.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
    const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;

    if (!best || dy < best.dy - 2 || (Math.abs(dy - best.dy) <= 2 && dx < best.dx)) {
      best = { span, rect, dy, dx };
    }
  }

  if (!best) return null;

  const textNode = best.span.firstChild;
  if (!(textNode instanceof Text)) return { node: best.span, offset: 0 };

  if (point.x <= best.rect.left) return { node: textNode, offset: 0 };
  if (point.x >= best.rect.right) return { node: textNode, offset: textNode.length };

  // Pointer is above/below the span but inside its horizontal extent: pick the character under x.
  const caret = caretFromPoint(point.x, best.rect.top + best.rect.height / 2);
  if (caret && caret.node === textNode) return caret;

  const ratio = (point.x - best.rect.left) / best.rect.width;
  return { node: textNode, offset: Math.round(ratio * textNode.length) };
}

function resolveFocus(point: Point, fallbackLayer: HTMLElement | null): TextPosition | null {
  const under = document.elementFromPoint(point.x, point.y);
  const layer = under?.closest('.pdf-page-shell')?.querySelector<HTMLElement>('.textLayer') ?? fallbackLayer;
  if (!layer) return null;

  if (under?.closest(SPAN_SELECTOR) && layer.contains(under)) {
    const caret = caretFromPoint(point.x, point.y);
    if (caret && layer.contains(caret.node)) return caret;
  }

  return nearestTextPosition(layer, point);
}

function extendSelectionTo(selection: Selection, position: TextPosition): boolean {
  if (selection.rangeCount === 0) return false;
  if (selection.focusNode === position.node && selection.focusOffset === position.offset) return false;

  selection.extend(position.node, position.offset);
  return true;
}

// A browser-driven drag whose pointer is over empty space leaves the focus parked at the
// guard element. Move it to the nearest text instead. Returns true if the selection changed.
function snapDragToNearestText(selection: Selection, point: Point): boolean {
  const anchorLayer = toElement(selection.anchorNode)?.closest<HTMLElement>('.textLayer') ?? null;
  if (!anchorLayer) return false;

  const under = document.elementFromPoint(point.x, point.y);
  if (under?.closest(SPAN_SELECTOR)) return false;

  const focus = resolveFocus(point, anchorLayer);
  return focus !== null && extendSelectionTo(selection, focus);
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

export function installPdfSelectionGuard(): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  let isPointerDown = false;
  let isFirefox: boolean | undefined;
  let prevRange: Range | null = null;
  let lastPointer: Point | null = null;
  // Set while a drag that started in empty page space is driven by us instead of the browser.
  let gapDrag: { layer: HTMLElement; scroller: HTMLElement | null; frame: number } | null = null;

  const resetAll = () => getTextLayers().forEach(resetLayer);

  const stopGapDrag = () => {
    if (!gapDrag) return;
    cancelAnimationFrame(gapDrag.frame);
    gapDrag = null;
  };

  const extendGapDrag = () => {
    if (!gapDrag || !lastPointer) return;

    const selection = document.getSelection();
    const focus = resolveFocus(lastPointer, gapDrag.layer);
    if (selection && focus) extendSelectionTo(selection, focus);
  };

  // The browser autoscrolls its own drags, but not ours, so mimic it near the scroller's edges.
  const autoscrollGapDrag = () => {
    if (!gapDrag) return;

    const { scroller } = gapDrag;
    if (scroller && lastPointer) {
      const bounds = scroller.getBoundingClientRect();
      const overTop = bounds.top + AUTOSCROLL_EDGE - lastPointer.y;
      const overBottom = lastPointer.y - (bounds.bottom - AUTOSCROLL_EDGE);
      const over = overTop > 0 ? -overTop : overBottom > 0 ? overBottom : 0;

      if (over !== 0) {
        scroller.scrollTop += Math.sign(over) * Math.min(AUTOSCROLL_MAX_STEP, Math.abs(over) / 3 + 2);
        extendGapDrag();
      }
    }

    gapDrag.frame = requestAnimationFrame(autoscrollGapDrag);
  };

  document.addEventListener('pointerdown', () => {
    isPointerDown = true;
  }, { signal });

  document.addEventListener('pointerup', (event) => {
    const wasGapDrag = gapDrag !== null;
    isPointerDown = false;
    stopGapDrag();

    // selectionchange is async and can arrive after the pointer is already up
    // (quick drags), so the final snap has to happen here too.
    const selection = document.getSelection();
    if (!wasGapDrag && !isFirefox && selection && selection.rangeCount > 0) {
      snapDragToNearestText(selection, { x: event.clientX, y: event.clientY });
    }

    resetAll();
  }, { signal });

  window.addEventListener('blur', () => {
    isPointerDown = false;
    stopGapDrag();
    resetAll();
  }, { signal });

  document.addEventListener('keyup', () => {
    if (!isPointerDown) resetAll();
  }, { signal });

  document.addEventListener('mousemove', (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };

    if (!gapDrag) return;
    if (event.buttons === 0) {
      stopGapDrag();
      return;
    }
    extendGapDrag();
  }, { signal, capture: true });

  // Starting a drag on empty page space: the browser would anchor at the guard element
  // (end of the page), so anchor at the nearest text ourselves and drive the drag.
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;

    const target = event.target;
    if (!(target instanceof Element) || target.closest(SPAN_SELECTOR) || target.closest('button')) return;

    const shell = target.closest<HTMLElement>('.pdf-page-shell');
    const layer = shell?.querySelector<HTMLElement>('.textLayer');
    // select-none on the shell means screenshot mode owns the drag.
    if (!shell || !layer || getComputedStyle(shell).userSelect === 'none') return;

    const point = { x: event.clientX, y: event.clientY };
    const selection = document.getSelection();
    const start = resolveFocus(point, layer);
    if (!selection || !start) return;

    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    selection.collapse(start.node, start.offset);
    lastPointer = point;
    stopGapDrag();
    gapDrag = { layer, scroller: findScrollParent(layer), frame: 0 };
    gapDrag.frame = requestAnimationFrame(autoscrollGapDrag);
  }, { signal, capture: true });

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();

    if (!selection || selection.rangeCount === 0) {
      resetAll();
      return;
    }

    const layers = getTextLayers();
    if (layers.length === 0) return;

    const activeLayers = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      for (const layer of layers) {
        if (!activeLayers.has(layer) && range.intersectsNode(layer)) {
          activeLayers.add(layer);
        }
      }
    }

    for (const layer of layers) {
      if (activeLayers.has(layer)) {
        layer.classList.add('selecting');
      } else {
        resetLayer(layer);
      }
    }

    if (isFirefox === undefined) {
      const sampleEnd = layers.map(getEndDiv).find((end): end is HTMLElement => end !== null);
      if (!sampleEnd) return;
      isFirefox = getComputedStyle(sampleEnd).getPropertyValue('-moz-user-select') === 'none';
    }
    // Firefox already keeps the selection inside the layer on its own.
    if (isFirefox) return;

    // Browser-driven drag whose pointer is over empty space: the guard froze the focus at
    // the current end, so move it to the nearest text instead. The resulting selectionchange
    // comes back through here and continues below.
    if (isPointerDown && !gapDrag && lastPointer && snapDragToNearestText(selection, lastPointer)) {
      return;
    }

    const range = selection.getRangeAt(0);
    // If the end stayed put, the user is dragging the start edge.
    const modifyStart = prevRange !== null && (
      range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
    );

    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (anchor instanceof Element && anchor.classList.contains('highlight')) anchor = anchor.parentNode;

    if (anchor && !modifyStart && range.endOffset === 0) {
      let node: Node | null = anchor;
      do {
        while (node && !node.previousSibling) node = node.parentNode;
        node = node?.previousSibling ?? null;
      } while (node && node.childNodes.length === 0);
      anchor = node;
    }

    const anchorParent = anchor?.parentElement ?? null;
    const layer = anchorParent?.closest<HTMLElement>('.textLayer') ?? null;
    const end = layer ? getEndDiv(layer) : null;

    if (anchor && anchorParent && layer && end) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchorParent.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }

    prevRange = range.cloneRange();
  }, { signal });

  return () => {
    controller.abort();
    stopGapDrag();
    resetAll();
  };
}
