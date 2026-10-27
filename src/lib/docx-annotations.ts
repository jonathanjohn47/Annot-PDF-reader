// Highlights, selection and "where am I" for a Word document shown as HTML.
//
// A PDF page has fixed coordinates; a Word document does not, so a highlight is anchored by its text: character
// offsets in the document's readable text, plus the quoted text and its surroundings to find it again if the offsets
// stop matching. The functions that touch the DOM only use `document` inside their bodies, so the pure ones
// (resolveAnchor, buildDocxHighlightsMarkdown) can be tested without a browser.

import type { DocxHighlight } from '../types/index.ts';

const VIRTUAL_BREAK = '\n';
const MATH_PLACEHOLDER = '￼';
const CONTEXT_CHARS = 40;
const BLOCK_TAGS = new Set(['P', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL', 'HEADER']);

export interface TextSlice {
  node: Text;
  start: number;
  end: number;
}

export interface TextModel {
  text: string;
  slices: TextSlice[];
}

/** The readable text of the rendered document. Equations count as one placeholder character and are never split. */
export function collectText(root: Node): TextModel {
  const slices: TextSlice[] = [];
  let text = '';

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const value = child.nodeValue ?? '';
        if (value) {
          slices.push({ node: child as Text, start: text.length, end: text.length + value.length });
          text += value;
        }
      } else if (child.nodeType === 1) {
        const element = child as Element;
        const tag = element.tagName.toUpperCase();
        if (tag === 'MATH') {
          text += MATH_PLACEHOLDER;
        } else if (tag === 'SCRIPT' || tag === 'STYLE') {
          continue;
        } else {
          walk(element);
          if (BLOCK_TAGS.has(tag) && !text.endsWith(VIRTUAL_BREAK)) text += VIRTUAL_BREAK;
        }
      }
    }
  };

  walk(root);
  return { text, slices };
}

function boundaryOffset(model: TextModel, container: Node, offset: number): number {
  if (container.nodeType === 3) {
    const slice = model.slices.find((item) => item.node === container);
    if (slice) return slice.start + Math.min(offset, slice.end - slice.start);
  }
  // A boundary between elements (or inside an equation): the first piece of text that starts at or after it.
  const probe = document.createRange();
  probe.setStart(container, offset);
  probe.collapse(true);
  for (const slice of model.slices) {
    if (probe.comparePoint(slice.node, 0) >= 0) return slice.start;
  }
  return model.text.length;
}

export interface Anchor {
  start: number;
  end: number;
  text: string;
  prefix: string;
  suffix: string;
}

/** Turns a user's selection into an anchor, or null when it covers no text. */
export function rangeToAnchor(root: Node, range: Range): Anchor | null {
  const model = collectText(root);
  let start = boundaryOffset(model, range.startContainer, range.startOffset);
  let end = boundaryOffset(model, range.endContainer, range.endOffset);
  while (start < end && /\s/.test(model.text[start])) start += 1;
  while (end > start && /\s/.test(model.text[end - 1])) end -= 1;
  if (end <= start) return null;
  return {
    start,
    end,
    text: model.text.slice(start, end),
    prefix: model.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: model.text.slice(end, end + CONTEXT_CHARS),
  };
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** Where a highlight sits in the current text: at its saved offsets if they still match, else the best quote match. */
export function resolveAnchor(
  fullText: string,
  highlight: Pick<DocxHighlight, 'start' | 'end' | 'text' | 'prefix' | 'suffix'>,
): { start: number; end: number } | null {
  if (!highlight.text) return null;
  if (fullText.slice(highlight.start, highlight.end) === highlight.text) {
    return { start: highlight.start, end: highlight.end };
  }
  let best: { start: number; score: number } | null = null;
  let from = fullText.indexOf(highlight.text);
  while (from !== -1) {
    const score = commonSuffixLength(fullText.slice(Math.max(0, from - CONTEXT_CHARS), from), highlight.prefix)
      + commonPrefixLength(fullText.slice(from + highlight.text.length, from + highlight.text.length + CONTEXT_CHARS), highlight.suffix);
    if (!best || score > best.score || (score === best.score && Math.abs(from - highlight.start) < Math.abs(best.start - highlight.start))) {
      best = { start: from, score };
    }
    from = fullText.indexOf(highlight.text, from + 1);
  }
  return best ? { start: best.start, end: best.start + highlight.text.length } : null;
}

/** Wraps each highlight's text in <mark> elements. Returns the ids that could not be placed any more. */
export function applyHighlights(root: HTMLElement, highlights: DocxHighlight[]): string[] {
  const orphaned: string[] = [];
  for (const highlight of highlights) {
    const model = collectText(root);
    const spot = resolveAnchor(model.text, highlight);
    if (!spot) {
      orphaned.push(highlight.id);
      continue;
    }
    for (const slice of model.slices) {
      const from = Math.max(spot.start, slice.start) - slice.start;
      const to = Math.min(spot.end, slice.end) - slice.start;
      if (to <= from) continue;
      const range = document.createRange();
      range.setStart(slice.node, from);
      range.setEnd(slice.node, to);
      const mark = document.createElement('mark');
      mark.className = `docx-hl docx-hl--${highlight.type}`;
      mark.dataset.hlId = highlight.id;
      if (highlight.note?.trim()) mark.dataset.hasNote = '1';
      mark.title = highlight.note?.trim() ? `Memo: ${highlight.note.trim()}` : '';
      range.surroundContents(mark);
    }
  }
  return orphaned;
}

export function highlightIdAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
  return element?.closest<HTMLElement>('mark[data-hl-id]')?.dataset.hlId ?? null;
}

// ── Safe HTML ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DROP_TAGS = 'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,audio,video,source,template,noscript';
const SAFE_URL = /^(https?:|mailto:|#|data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp);base64,)/i;

/** The HTML comes from a file the user opened, not from Annot: drop anything that could run code or load remote content. */
export function sanitizeDocxHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="docx-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('docx-root');
  if (!root) return '';
  root.querySelectorAll(DROP_TAGS).forEach((element) => element.remove());
  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && !SAFE_URL.test(value)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'style' && /url\s*\(|expression|@import/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return root.innerHTML;
}

// ── Where the reader is ────────────────────────────────────────────────────────────────────────────────────────────

const LOCATION_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,tr,pre,blockquote,figcaption';

function squash(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(new RegExp(MATH_PLACEHOLDER, 'g'), ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Describes what is at the top of the visible area (the section it is in and its first words), so the chat can
 * treat "this" and "here" as that passage, the way it does with the current page of a PDF.
 */
export function describeViewLocation(root: HTMLElement, viewport: HTMLElement): string | null {
  const top = viewport.getBoundingClientRect().top + 12;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(LOCATION_BLOCKS)).filter((element) => (element.textContent ?? '').trim());
  if (blocks.length === 0) return null;
  const index = blocks.findIndex((element) => element.getBoundingClientRect().bottom > top);
  const current = blocks[index === -1 ? blocks.length - 1 : index];

  const trail: Array<{ level: number; text: string }> = [];
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))) {
    if (heading !== current && !(heading.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    const level = Number(heading.tagName.slice(1));
    while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
    trail.push({ level, text: squash(heading.textContent ?? '', 80) });
    if (heading === current) break;
  }

  const parts: string[] = [];
  if (trail.length) parts.push(`section "${trail.map((item) => item.text).join(' > ')}"`);
  parts.push(`the top of the screen is at: "${squash(current.textContent ?? '', 240)}"`);
  const next = blocks[(index === -1 ? blocks.length - 1 : index) + 1];
  if (next && current.tagName !== 'TR') parts.push(`what follows begins: "${squash(next.textContent ?? '', 120)}"`);
  return `${parts.join('; ')} (block ${(index === -1 ? blocks.length : index + 1)} of ${blocks.length})`;
}

// ── Export and reading aloud ───────────────────────────────────────────────────────────────────────────────────────

function escapeMarkdownBlock(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(new RegExp(MATH_PLACEHOLDER, 'g'), '[equation]')
    .split('\n')
    .map((line) => line.replace(/^>/, '\\>'))
    .join('\n');
}

function markdownSection(title: string, highlights: DocxHighlight[]): string[] {
  if (highlights.length === 0) return [`## ${title}`, '', 'None.', ''];
  const lines = [`## ${title}`, ''];
  highlights.forEach((highlight, index) => {
    lines.push(`### ${index + 1}`, '', `> ${escapeMarkdownBlock(highlight.text.trim())}`);
    if (highlight.note?.trim()) lines.push('', `Memo: ${highlight.note.trim()}`);
    lines.push('');
  });
  return lines;
}

export function buildDocxHighlightsMarkdown(docxPath: string, highlights: DocxHighlight[], generated = new Date()): string {
  const ordered = [...highlights].sort((a, b) => a.start - b.start);
  const title = (docxPath.split('/').pop() ?? docxPath).replace(/\.docx$/i, '');
  return [
    `# ${title} Highlights`,
    '',
    `Source document: \`${docxPath}\``,
    `Generated: ${generated.toISOString()}`,
    '',
    ...markdownSection('Yellow Highlights', ordered.filter((h) => h.type === 'important')),
    ...markdownSection('Red Highlights', ordered.filter((h) => h.type === 'unknown')),
  ].join('\n').trimEnd() + '\n';
}

/** Paragraphs of a selection, for the read-aloud voice. Equations were placeholders and are simply dropped. */
export function selectionParagraphs(selectedText: string): string[] {
  return selectedText
    .replace(new RegExp(MATH_PLACEHOLDER, 'g'), ' ')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
}

// ── Hand editing ───────────────────────────────────────────────────────────────────────────────────────────────────

const EDIT_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,td,th';
const SKIPPED_INLINE = new Set(['UL', 'OL', 'TABLE', 'FIGURE', 'IMG', 'SCRIPT', 'STYLE']);
export const FLAG_BOLD = 1;
export const FLAG_ITALIC = 2;
export const FLAG_UNDERLINE = 4;

export interface EditBlockPayload {
  tag: string;
  segments: Array<[string, number]>;
  touched: boolean;
  image?: { mime: string; data: string; width: number; height: number };
}

/** Marks a picture the user added in this editing session (the ones from the file have no such mark). */
export const NEW_PICTURE_ATTRIBUTE = 'data-annot-new';

function inlineSegments(block: Element): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const push = (text: string, flags: number) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[1] === flags) last[0] += text;
    else out.push([text, flags]);
  };
  const walk = (node: Node, flags: number): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        push((child.nodeValue ?? '').replace(/\s+/g, ' '), flags);
      } else if (child.nodeType === 1) {
        const element = child as Element;
        const tag = element.tagName.toUpperCase();
        if (SKIPPED_INLINE.has(tag) || element.matches(EDIT_BLOCKS)) continue;   // other blocks are read on their own
        if (tag === 'MATH') push(MATH_PLACEHOLDER, 0);
        else if (tag === 'BR') push(' ', flags);
        else {
          walk(element, flags
            | (tag === 'B' || tag === 'STRONG' ? FLAG_BOLD : 0)
            | (tag === 'I' || tag === 'EM' ? FLAG_ITALIC : 0)
            | (tag === 'U' || element.classList.contains('underline') ? FLAG_UNDERLINE : 0));
        }
      }
    }
  };
  walk(block, 0);
  return out;
}

function blockTag(element: Element): string {
  if (element.closest('header#title-block-header')) return 'meta';
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return tag;
  if (tag === 'li') return 'li';
  if (tag === 'td' || tag === 'th') return 'cell';
  return 'p';
}

/** The edited document as a list of paragraphs with their bold/italic/underline runs, for the Word editor. */
export function extractEditBlocks(root: HTMLElement): EditBlockPayload[] {
  const blocks: EditBlockPayload[] = [];
  for (const element of Array.from(root.querySelectorAll(`${EDIT_BLOCKS},img[${NEW_PICTURE_ATTRIBUTE}]`))) {
    if (element.tagName === 'IMG') {
      const match = /^data:(image\/(?:png|jpeg|gif));base64,(.+)$/.exec(element.getAttribute('src') ?? '');
      const img = element as HTMLImageElement;
      if (match) {
        blocks.push({
          tag: 'image',
          segments: [],
          touched: true,
          image: { mime: match[1], data: match[2], width: img.naturalWidth || img.width || 1, height: img.naturalHeight || img.height || 1 },
        });
      }
      continue;
    }
    const segments = inlineSegments(element);
    if (!segments.some(([text]) => text.trim())) continue;
    blocks.push({ tag: blockTag(element), segments, touched: (element as HTMLElement).dataset.touched === '1' });
  }
  return blocks;
}

/** Marks the paragraphs the user worked in, so only those can have their formatting rewritten. */
export function markTouched(root: HTMLElement, from: Node | null, to: Node | null = from): void {
  const mark = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    const block = element?.closest<HTMLElement>(EDIT_BLOCKS);
    if (block && root.contains(block)) block.dataset.touched = '1';
  };
  mark(from);
  mark(to);
}

export function markSelectionTouched(root: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  markTouched(root, range.startContainer, range.endContainer);
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(EDIT_BLOCKS))) {
    if (range.intersectsNode(element)) element.dataset.touched = '1';
  }
}

/** Tables, equations and pictures cannot be added or removed by hand yet; the counts must not change. */
export function structureCounts(root: HTMLElement): { tables: number; equations: number; pictures: number } {
  return {
    tables: root.querySelectorAll('table').length,
    equations: root.querySelectorAll('math').length,
    pictures: root.querySelectorAll(`img:not([${NEW_PICTURE_ATTRIBUTE}])`).length,
  };
}

/** A pasted or chosen picture as a PNG/JPEG/GIF data URL with its pixel size. Other formats are redrawn as PNG. */
export async function pictureFromFile(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const read = (): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the picture.'));
    reader.readAsDataURL(file);
  });
  const load = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file is not a picture the browser can open.'));
    image.src = src;
  });
  let dataUrl = await read();
  const image = await load(dataUrl);
  if (!/^data:image\/(png|jpeg|gif);base64,/.test(dataUrl)) {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    dataUrl = canvas.toDataURL('image/png');
  }
  return { dataUrl, width: image.naturalWidth, height: image.naturalHeight };
}
