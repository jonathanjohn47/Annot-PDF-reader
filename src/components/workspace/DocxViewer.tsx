'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Bold,
  Download,
  Eraser,
  FileDown,
  Highlighter,
  ImagePlus,
  Italic,
  Loader2,
  MessageSquare,
  Minus,
  NotebookPen,
  Pause,
  Pen,
  Play,
  Plus,
  Redo2,
  Save,
  Square,
  SquarePen,
  Trash2,
  Underline,
  Undo2,
  Volume2,
  X,
} from 'lucide-react';

import { MarkdownPreviewDialog } from '@/components/common/MarkdownPreviewDialog';
import { NotesDialog } from '@/components/workspace/NotesDialog';
import { useSpeechPlayer } from '@/components/workspace/useSpeechPlayer';
import {
  applyHighlights,
  buildDocxHighlightsMarkdown,
  collectText,
  describeViewLocation,
  extractEditBlocks,
  highlightIdAt,
  markSelectionTouched,
  markTouched,
  NEW_PICTURE_ATTRIBUTE,
  pictureFromFile,
  rangeToAnchor,
  resolveAnchor,
  sanitizeDocxHtml,
  selectionParagraphs,
  structureCounts,
} from '@/lib/docx-annotations';
import { chunkParagraphs } from '@/lib/speech-text';
import { useWorkspace, viewerLocation } from '@/lib/workspace-store';
import type { DocxHighlight } from '@/types';

const SCROLL_STORAGE_KEY = 'annot-docx-scroll';
const SAVE_NOTICE_KEY = 'annot-docx-save-understood';
const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
const MIN_ZOOM = 70;
const MAX_ZOOM = 200;

type HighlightMode = DocxHighlight['type'] | null;

function readScrollRatio(path: string): number {
  try {
    const value = Number((JSON.parse(window.localStorage.getItem(SCROLL_STORAGE_KEY) ?? '{}') as Record<string, number>)[path]);
    return Number.isFinite(value) && value > 0 && value < 1 ? value : 0;
  } catch {
    return 0;
  }
}

function writeScrollRatio(path: string, ratio: number): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(SCROLL_STORAGE_KEY) ?? '{}') as Record<string, number>;
    if (ratio < 0.01) delete all[path];
    else all[path] = Math.round(ratio * 1000) / 1000;
    window.localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // The reading position is a convenience; losing it must not break reading.
  }
}

function clearHighlightMarks(root: HTMLElement): void {
  root.querySelectorAll('mark.docx-hl').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

export function DocxViewer() {
  const { activePdf, closePdf, activeSessionFolder, chatOpen, toggleChat, selectedText, setSelectedText } = useWorkspace();
  const docPath = activePdf?.path ?? '';

  const [html, setHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [highlights, setHighlights] = useState<DocxHighlight[]>([]);
  const [highlightsLoaded, setHighlightsLoaded] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [highlightMode, setHighlightMode] = useState<HighlightMode>(null);
  const [eraseMode, setEraseMode] = useState(false);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMarkdown, setExportMarkdown] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState(0);
  const [htmlVersion, setHtmlVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backups, setBackups] = useState(0);
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const editCountsRef = useRef({ tables: 0, equations: 0, pictures: 0 });
  const caretRef = useRef<Range | null>(null);
  const pictureInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const highlightsRef = useRef<DocxHighlight[]>([]);
  highlightsRef.current = highlights;

  const speech = useSpeechPlayer();
  const stopSpeech = speech.stop;
  useEffect(() => stopSpeech, [docPath, stopSpeech]);

  const selectedHighlight = useMemo(
    () => highlights.find((item) => item.id === selectedHighlightId) ?? null,
    [highlights, selectedHighlightId],
  );

  // ── load the document and its highlights ──
  useEffect(() => {
    if (!docPath) return;
    let cancelled = false;
    const query = `path=${encodeURIComponent(docPath)}`;

    (async () => {
      try {
        const [docRes, hlRes] = await Promise.all([
          fetch(`/api/workspace/docx?${query}`, { cache: 'no-store' }),
          fetch(`/api/workspace/docx/highlights?${query}`, { cache: 'no-store' }),
        ]);
        const doc = await docRes.json();
        if (!docRes.ok || typeof doc?.html !== 'string') {
          throw new Error(typeof doc?.error === 'string' ? doc.error : 'Failed to open this Word file.');
        }
        const saved = hlRes.ok ? await hlRes.json() : { highlights: [] };
        if (cancelled) return;
        setHighlights(Array.isArray(saved?.highlights) ? saved.highlights : []);
        setHighlightsLoaded(true);
        setBackups(Number(doc.backups) || 0);
        setHtml(sanitizeDocxHtml(doc.html));
        setHtmlVersion((version) => version + 1);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Failed to open this Word file.');
      }
    })();

    return () => { cancelled = true; };
  }, [docPath, reloadKey]);

  // The document body is set once; highlights are then wrapped around its text and unwrapped again on change.
  useEffect(() => {
    const root = contentRef.current;
    if (!root || html === null) return;
    root.innerHTML = html;
    const scroller = scrollRef.current;
    if (scroller) {
      const ratio = readScrollRatio(docPath);
      const restore = () => { scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight); };
      restore();
      const timer = window.setTimeout(() => { if (scroller.scrollTop < 40) restore(); }, 500);
      return () => window.clearTimeout(timer);
    }
  }, [html, htmlVersion, docPath]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root || html === null || !highlightsLoaded || editing) return;
    clearHighlightMarks(root);
    applyHighlights(root, highlights);
    root.querySelectorAll('mark.docx-hl').forEach((mark) => {
      mark.classList.toggle('docx-hl--selected', (mark as HTMLElement).dataset.hlId === selectedHighlightId);
    });
  }, [html, htmlVersion, highlights, highlightsLoaded, selectedHighlightId, editing]);

  // ── the chat asks where the reader is only when a message is sent ──
  useEffect(() => {
    viewerLocation.current = () => {
      const root = contentRef.current;
      const scroller = scrollRef.current;
      return root && scroller ? describeViewLocation(root, scroller) : null;
    };
    return () => { viewerLocation.current = null; };
  }, []);

  // ── reading position and progress ──
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || html === null) return;
    let frame = 0;
    let saveTimer = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const span = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        const ratio = Math.min(1, scroller.scrollTop / span);
        setProgress(Math.round(ratio * 100));
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => writeScrollRatio(docPath, ratio), 400);
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(saveTimer);
    };
  }, [html, docPath]);

  // ── selected text goes to the chat ──
  useEffect(() => {
    let timer = 0;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = contentRef.current;
        const selection = window.getSelection();
        if (!root || !selection || selection.rangeCount === 0) return;
        const inside = root.contains(selection.anchorNode);
        if (inside) caretRef.current = selection.getRangeAt(0).cloneRange();
        if (selection.isCollapsed) {
          if (inside) setSelectedText(null);
          return;
        }
        if (!inside) return;
        const text = selection.toString().replace(/￼/g, ' ').trim();
        setSelectedText(text || null);
      }, 150);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [setSelectedText]);

  // ── saving ──
  const persist = useCallback(async (next: DocxHighlight[]) => {
    setHighlights(next);
    try {
      const res = await fetch(`/api/workspace/docx/highlights?path=${encodeURIComponent(docPath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlights: next }),
      });
      if (!res.ok) throw new Error('Could not save the highlights.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the highlights.');
    }
  }, [docPath]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? '' : current)), 3500);
  };

  // ── mouse: make or remove highlights, open a memo ──
  const handleMouseUp = () => {
    const root = contentRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) return;
    if (!highlightMode && !eraseMode) return;

    const anchor = rangeToAnchor(root, selection.getRangeAt(0));
    if (!anchor) return;

    if (eraseMode) {
      const model = collectText(root);
      const keep = highlightsRef.current.filter((item) => {
        const spot = resolveAnchor(model.text, item);
        return !spot || spot.end <= anchor.start || spot.start >= anchor.end;
      });
      if (keep.length !== highlightsRef.current.length) {
        void persist(keep);
        flash('Highlight removed.');
      }
    } else if (highlightMode) {
      const duplicate = highlightsRef.current.some((item) => item.type === highlightMode && item.start === anchor.start && item.end === anchor.end);
      if (!duplicate) {
        void persist([...highlightsRef.current, { id: crypto.randomUUID(), type: highlightMode, ...anchor, createdAt: new Date().toISOString() }]);
      }
    }
    selection.removeAllRanges();
    setSelectedText(null);
  };

  const handleClick = (event: React.MouseEvent) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const id = highlightIdAt(event.target);
    if (!id) {
      setSelectedHighlightId(null);
      return;
    }
    if (eraseMode) {
      void persist(highlightsRef.current.filter((item) => item.id !== id));
      flash('Highlight removed.');
      return;
    }
    const found = highlightsRef.current.find((item) => item.id === id);
    setSelectedHighlightId(id);
    setDraftNote(found?.note ?? '');
  };

  const saveMemo = () => {
    if (!selectedHighlight) return;
    const note = draftNote.trim();
    void persist(highlightsRef.current.map((item) => {
      if (item.id !== selectedHighlight.id) return item;
      const { note: _old, ...rest } = item;
      void _old;
      return note ? { ...rest, note } : rest;
    }));
    flash(note ? 'Memo saved.' : 'Memo cleared.');
    setSelectedHighlightId(null);
  };

  const deleteSelectedHighlight = () => {
    if (!selectedHighlight) return;
    void persist(highlightsRef.current.filter((item) => item.id !== selectedHighlight.id));
    setSelectedHighlightId(null);
  };

  // ── hand editing: the text is edited right in the page; Save writes only the changed paragraphs into the .docx ──
  const startEditing = () => {
    const root = contentRef.current;
    if (!root || html === null) return;
    clearHighlightMarks(root);
    editCountsRef.current = structureCounts(root);
    setHighlightMode(null);
    setEraseMode(false);
    setSelectedHighlightId(null);
    setDirty(false);
    setEditing(true);
    window.requestAnimationFrame(() => root.focus());
  };

  // A picture goes in as its own paragraph at the caret (or at the end if there is no caret in the page yet).
  const insertPicture = useCallback(async (file: File, at?: { x: number; y: number }) => {
    const root = contentRef.current;
    if (!root) return;
    try {
      if (file.size > MAX_PICTURE_BYTES) throw new Error('That picture is larger than 20 MB.');
      const { dataUrl, width } = await pictureFromFile(file);
      root.focus();
      const selection = window.getSelection();
      if (selection) {
        let range: Range | null = null;
        if (at && document.caretRangeFromPoint) range = document.caretRangeFromPoint(at.x, at.y);
        if (!range || !root.contains(range.startContainer)) range = caretRef.current && root.contains(caretRef.current.startContainer) ? caretRef.current : null;
        if (!range) {
          range = document.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('insertHTML', false, `<p><img ${NEW_PICTURE_ATTRIBUTE}="1" src="${dataUrl}" width="${Math.min(width, 640)}" alt=""></p>`);
      markSelectionTouched(root);
      setDirty(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add the picture.');
    }
  }, []);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    root.contentEditable = editing ? 'true' : 'false';
    root.spellcheck = editing;
    if (!editing) return;
    root.querySelectorAll('math, figure, img').forEach((element) => element.setAttribute('contenteditable', 'false'));
    document.execCommand('defaultParagraphSeparator', false, 'p');
    document.execCommand('styleWithCSS', false, 'false');

    const onBeforeInput = () => {
      const selection = window.getSelection();
      if (selection) markTouched(root, selection.anchorNode, selection.focusNode);
    };
    const onInput = () => setDirty(true);
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const picture = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith('image/'));
      if (text) document.execCommand('insertText', false, text);
      else if (picture) void insertPicture(picture);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const picture = Array.from(event.dataTransfer?.files ?? []).find((file) => file.type.startsWith('image/'));
      if (picture) void insertPicture(picture, { x: event.clientX, y: event.clientY });
    };
    const onDragOver = (event: DragEvent) => event.preventDefault();
    root.addEventListener('beforeinput', onBeforeInput);
    root.addEventListener('input', onInput);
    root.addEventListener('paste', onPaste);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragover', onDragOver);
    return () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('input', onInput);
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('dragover', onDragOver);
    };
  }, [editing, htmlVersion, insertPicture]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const runCommand = (command: string, value?: string) => {
    const root = contentRef.current;
    if (!root) return;
    root.focus();
    document.execCommand(command, false, value);
    markSelectionTouched(root);
    setDirty(true);
  };

  const reloadDocument = () => setReloadKey((key) => key + 1);

  const discardEdits = () => {
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return;
    setEditing(false);
    setDirty(false);
    setHtmlVersion((version) => version + 1);   // puts the document text back as it was
  };

  const performSave = async () => {
    const root = contentRef.current;
    if (!root) return;
    const before = editCountsRef.current;
    const now = structureCounts(root);
    if (now.tables !== before.tables || now.equations !== before.equations || now.pictures !== before.pictures) {
      flash('Tables and equations cannot be added or removed by hand yet, and neither can pictures that were already in the file. Undo that change (Ctrl+Z), then save.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/workspace/docx', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: docPath, blocks: extractEditBlocks(root) }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok !== true) throw new Error(typeof data?.error === 'string' ? data.error : 'Could not save the Word file.');
      setEditing(false);
      setDirty(false);
      setBackups(Number(data.backups) || 0);
      const parts = [
        data.changed ? `${data.changed} paragraph${data.changed === 1 ? '' : 's'} changed` : '',
        data.inserted ? `${data.inserted} added` : '',
        data.deleted ? `${data.deleted} removed` : '',
        data.images ? `${data.images} picture${data.images === 1 ? '' : 's'} added` : '',
      ].filter(Boolean);
      flash(data.unchanged ? 'Nothing to save: the file already matches.' : `Saved (${parts.join(', ')}). The previous version is kept: use Undo save to go back.`);
      if (Array.isArray(data.warnings) && data.warnings.length) window.setTimeout(() => flash(String(data.warnings[0])), 3800);
      reloadDocument();
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Could not save the Word file.');
    } finally {
      setSaving(false);
    }
  };

  const requestSave = () => {
    if (saving || !dirty) return;
    let understood = false;
    try { understood = window.localStorage.getItem(SAVE_NOTICE_KEY) === '1'; } catch { /* ask again */ }
    if (understood) void performSave();
    else setConfirmSaveOpen(true);
  };

  const undoLastSave = async () => {
    if (!window.confirm('Go back to the version before your last save?')) return;
    try {
      const res = await fetch('/api/workspace/docx', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: docPath, action: 'undo' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Could not undo the save.');
      setBackups(Number(data.backups) || 0);
      flash('Went back to the earlier version.');
      reloadDocument();
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Could not undo the save.');
    }
  };

  const closeDocument = () => {
    if (editing && dirty && !window.confirm('You have unsaved changes. Close without saving?')) return;
    closePdf();
  };

  const toggleMode = (mode: 'important' | 'unknown') => {
    setEraseMode(false);
    setHighlightMode((current) => (current === mode ? null : mode));
  };

  const handleReadSelection = () => {
    void speech.start(chunkParagraphs(selectionParagraphs(selectedText ?? '')).map((text) => ({ text })));
  };

  const openExport = () => {
    setExportMarkdown(buildDocxHighlightsMarkdown(docPath, highlightsRef.current));
    setExportOpen(true);
  };

  const confirmExport = () => {
    const blob = new Blob([exportMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(activePdf?.name ?? 'document').replace(/\.docx$/i, '')}.highlights.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };

  if (!activePdf) return null;

  const iconButton = 'w-6 h-6 rounded flex items-center justify-center transition-colors';
  const idle = 'text-on-surface-variant hover:bg-surface-container-high';

  return (
    <div className="h-full flex flex-col">
      <div className="h-10 px-4 flex items-center justify-between bg-surface shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={closeDocument} className={`${iconButton} ${idle} shrink-0`} title="Close document">
            <X size={13} strokeWidth={2} />
          </button>
          <span className="text-xs font-medium text-on-surface truncate">{activePdf.name}</span>
        </div>

        <div className="flex items-center gap-1 glass rounded-lg px-2 py-0.5">
          <span className="text-[11px] text-on-surface-variant font-medium tabular-nums w-9 text-center" title="How far you have read">
            {progress}%
          </span>

          <div className="w-px h-4 bg-outline-variant/30 mx-0.5" />

          <span className="text-[11px] text-on-surface-variant font-medium tabular-nums w-9 text-center">{zoom}%</span>
          <button onClick={() => setZoom(Math.max(MIN_ZOOM, zoom - 10))} className={`${iconButton} ${idle}`} title="Smaller text">
            <Minus size={13} strokeWidth={2} />
          </button>
          <button onClick={() => setZoom(Math.min(MAX_ZOOM, zoom + 10))} className={`${iconButton} ${idle}`} title="Larger text">
            <Plus size={13} strokeWidth={2} />
          </button>

          <div className="w-px h-4 bg-outline-variant/30 mx-0.5" />

          <button
            disabled={editing}
            onClick={() => toggleMode('unknown')}
            className={`${iconButton} ${highlightMode === 'unknown' ? 'bg-error text-on-error' : idle} disabled:opacity-40`}
            title="Toggle unknown (red) highlight mode"
          >
            <Pen size={12} strokeWidth={2} />
          </button>
          <button
            disabled={editing}
            onClick={() => toggleMode('important')}
            className={`${iconButton} ${highlightMode === 'important' ? 'bg-amber-400 text-black' : idle} disabled:opacity-40`}
            title="Toggle important (yellow) highlight mode"
          >
            <Highlighter size={12} strokeWidth={2} />
          </button>
          <button
            disabled={editing}
            onClick={() => { setHighlightMode(null); setEraseMode((current) => !current); }}
            className={`${iconButton} ${eraseMode ? 'bg-on-surface text-surface-container-lowest' : idle} disabled:opacity-40`}
            title="Erase highlights: click one, or select text over them"
          >
            <Eraser size={12} strokeWidth={2} />
          </button>
          <div className="w-px h-4 bg-outline-variant/30 mx-0.5" />

          {!editing ? (
            <>
              <button onClick={startEditing} className={`${iconButton} ${idle}`} title="Edit the text by hand (changes are written into the Word file when you save)">
                <SquarePen size={12} strokeWidth={2} />
              </button>
              {backups > 0 && (
                <button onClick={() => void undoLastSave()} className={`${iconButton} ${idle}`} title="Undo save: go back to the version before the last save">
                  <Undo2 size={12} strokeWidth={2} />
                </button>
              )}
            </>
          ) : (
            <>
              <select
                aria-label="Paragraph style"
                defaultValue="p"
                onChange={(event) => { runCommand('formatBlock', event.target.value); event.target.value = 'p'; }}
                className="h-6 rounded bg-transparent px-1 text-[11px] text-on-surface-variant outline-none hover:bg-surface-container-high"
                title="Turn the paragraph into a heading, or back into text"
              >
                <option value="p">Style</option>
                <option value="p">Text</option>
                <option value="h1">Heading 1</option>
                <option value="h2">Heading 2</option>
                <option value="h3">Heading 3</option>
              </select>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('bold')} className={`${iconButton} ${idle}`} title="Bold (Ctrl+B)"><Bold size={12} strokeWidth={2} /></button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('italic')} className={`${iconButton} ${idle}`} title="Italic (Ctrl+I)"><Italic size={12} strokeWidth={2} /></button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('underline')} className={`${iconButton} ${idle}`} title="Underline (Ctrl+U)"><Underline size={12} strokeWidth={2} /></button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => pictureInputRef.current?.click()} className={`${iconButton} ${idle}`} title="Insert a picture (or paste one with Ctrl+V, or drop it on the page)"><ImagePlus size={12} strokeWidth={2} /></button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('undo')} className={`${iconButton} ${idle}`} title="Undo typing (Ctrl+Z)"><Undo2 size={12} strokeWidth={2} /></button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('redo')} className={`${iconButton} ${idle}`} title="Redo typing"><Redo2 size={12} strokeWidth={2} /></button>
              <button
                onClick={requestSave}
                disabled={!dirty || saving}
                className="h-6 rounded bg-on-surface px-2 text-[11px] font-semibold text-surface-container-lowest transition-opacity hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1"
                title="Save into the Word file (Ctrl+S). The previous version is kept."
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} strokeWidth={2} />}
                Save
              </button>
              <button onClick={discardEdits} disabled={saving} className="h-6 rounded px-2 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container-high" title="Leave edit mode">
                {dirty ? 'Discard' : 'Done'}
              </button>
            </>
          )}

          <button onClick={openExport} className={`${iconButton} ${idle}`} title="Export highlights as Markdown">
            <FileDown size={12} strokeWidth={2} />
          </button>
          <button
            onClick={() => setNotesOpen(true)}
            className={`${iconButton} ${notesOpen ? 'bg-on-surface text-surface-container-lowest' : idle}`}
            title="Notes"
          >
            <NotebookPen size={12} strokeWidth={2} />
          </button>

          {(speech.status !== 'idle' || selectedText) && (
            <>
              <div className="w-px h-4 bg-outline-variant/30 mx-0.5" />
              {speech.status === 'idle' || speech.status === 'error' ? (
                <button
                  onClick={handleReadSelection}
                  className={`${iconButton} ${speech.status === 'error' ? 'text-error hover:bg-surface-container-high' : idle}`}
                  title={speech.status === 'error' ? 'Nothing readable in the selection, or the audio failed. Click to retry' : 'Read the selected text aloud'}
                >
                  <Volume2 size={12} strokeWidth={2} />
                </button>
              ) : (
                <>
                  <button
                    onClick={speech.status === 'paused' ? speech.resume : speech.pause}
                    disabled={speech.status === 'loading'}
                    className={`${iconButton} ${idle} disabled:opacity-60`}
                    title={speech.status === 'paused' ? 'Resume reading' : speech.status === 'loading' ? 'Loading audio...' : 'Pause reading'}
                  >
                    {speech.status === 'loading' ? <Loader2 size={12} className="animate-spin" /> : speech.status === 'paused' ? <Play size={12} /> : <Pause size={12} />}
                  </button>
                  <button onClick={stopSpeech} className={`${iconButton} ${idle}`} title="Stop reading">
                    <Square size={11} strokeWidth={2} />
                  </button>
                </>
              )}
            </>
          )}

          <a
            href={`/api/workspace/file?path=${encodeURIComponent(docPath)}`}
            download={activePdf.name}
            className={`${iconButton} ${idle}`}
            title="Download the original Word file"
          >
            <Download size={12} strokeWidth={2} />
          </a>
        </div>

        <div>
          {activeSessionFolder && (
            <button
              onClick={toggleChat}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${chatOpen ? 'bg-primary text-on-primary' : idle}`}
            >
              <MessageSquare size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-surface-dim">
        <div className="max-w-5xl mx-auto py-8 px-6">
          <div className="mb-4 px-2">
            <div className="text-[11px] uppercase tracking-widest text-on-surface-variant font-medium mb-1">{activePdf.path}</div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-on-surface-variant">
              {editing ? (
                <span>Editing. Type directly in the page. Press Save to write your changes into the Word file; the previous version is kept.{dirty ? ' You have unsaved changes.' : ''}</span>
              ) : eraseMode ? (
                <span>Erase mode is on. Click a highlight, or select text over highlights, to remove them.</span>
              ) : highlightMode ? (
                <span>{highlightMode === 'important' ? 'Yellow' : 'Red'} highlight mode is on. Select text to save a highlight.</span>
              ) : (
                <span>Select text to ask about it or read it aloud. Click a highlight to add a memo.</span>
              )}
              {notice && <span className="text-outline">{notice}</span>}
            </div>
          </div>

          {html === null && !loadError && (
            <div className="docx-paper min-h-[360px] flex items-center justify-center gap-2 text-sm text-on-surface-variant">
              <Loader2 size={16} className="animate-spin" />
              Opening Word file...
            </div>
          )}
          {loadError && (
            <div className="docx-paper min-h-[200px] flex items-center justify-center px-6 text-sm text-error text-center">
              {loadError}
            </div>
          )}
          {html !== null && (
            <div className="docx-paper" style={{ '--docx-zoom': zoom / 100 } as CSSProperties}>
              <div
                ref={contentRef}
                className={`docx-content ${eraseMode ? 'docx-erasing' : ''} ${editing ? 'docx-editing' : ''}`}
                onMouseUp={handleMouseUp}
                onClick={handleClick}
                onKeyDown={(event) => {
                  if (editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault();
                    requestSave();
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>

      <input
        ref={pictureInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void insertPicture(file);
        }}
      />

      <MarkdownPreviewDialog
        open={exportOpen}
        title="Preview Highlight Markdown"
        description="Review the generated highlight markdown before downloading it."
        fileName={`${activePdf.name.replace(/\.docx$/i, '')}.highlights.md`}
        markdown={exportMarkdown}
        confirmLabel="Download Markdown"
        onCancel={() => setExportOpen(false)}
        onConfirm={confirmExport}
      />

      {confirmSaveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6">
          <div className="w-full max-w-md rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-5 shadow-ambient">
            <div className="text-sm font-semibold text-on-surface">Save into the Word file?</div>
            <p className="mt-2 text-xs leading-5 text-on-surface-variant">
              Only the paragraphs you changed are rewritten; everything else in the file stays exactly as it was.
              Inside a changed paragraph, text colours and fonts are kept, but links and mixed formatting can be simplified.
              The version before this save is kept, and the Undo save button brings it back.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmSaveOpen(false)} className="rounded-xl px-3 py-2 text-xs font-medium text-on-surface-variant hover:bg-surface-container-high">
                Not yet
              </button>
              <button
                onClick={() => {
                  try { window.localStorage.setItem(SAVE_NOTICE_KEY, '1'); } catch { /* it will ask again next time */ }
                  setConfirmSaveOpen(false);
                  void performSave();
                }}
                className="rounded-xl bg-on-surface px-3 py-2 text-xs font-semibold text-surface-container-lowest hover:opacity-90"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <NotesDialog open={notesOpen} pdfPath={docPath} pdfName={activePdf.name} onClose={() => setNotesOpen(false)} />

      {selectedHighlight && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6" onClick={() => setSelectedHighlightId(null)}>
          <div
            className="w-full max-w-xl rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-5 shadow-ambient"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm font-semibold text-on-surface">
                Highlight Memo
                <span className="ml-2 text-xs font-normal text-on-surface-variant">{selectedHighlight.type === 'important' ? 'Yellow' : 'Red'} highlight</span>
              </div>
              <button onClick={() => setSelectedHighlightId(null)} className="shrink-0 rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-high">
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <p className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface">
              {selectedHighlight.text.replace(/￼/g, '[equation]')}
            </p>
            <label className="mt-4 mb-1 block text-[11px] font-medium text-on-surface-variant">Memo</label>
            <textarea
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
              placeholder="Add a memo for this highlight..."
              className="min-h-28 w-full rounded-lg border border-outline-variant/30 bg-surface px-3 py-2 text-sm text-on-surface outline-none transition-colors focus:border-outline"
            />
            <div className="mt-4 flex items-center justify-between">
              <button
                onClick={deleteSelectedHighlight}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-error transition-colors hover:bg-surface-container-high"
              >
                <Trash2 size={12} strokeWidth={2} />
                Remove highlight
              </button>
              <div className="flex gap-2">
                <button onClick={() => setSelectedHighlightId(null)} className="rounded-xl px-3 py-2 text-xs font-medium text-on-surface-variant hover:bg-surface-container-high">
                  Close
                </button>
                <button
                  onClick={saveMemo}
                  disabled={draftNote.trim() === (selectedHighlight.note ?? '').trim()}
                  className="rounded-xl bg-on-surface px-3 py-2 text-xs font-semibold text-surface-container-lowest transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Save memo
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
