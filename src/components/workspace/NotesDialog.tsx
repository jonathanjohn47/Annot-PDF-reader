'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageCircleQuestion, NotebookPen, Plus, Save, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { normalizeMathMarkdown } from '@/lib/markdown-math';
import { useWorkspace } from '@/lib/workspace-store';
import { PdfNote } from '@/types';
import { AskQuestionDialog } from '@/components/workspace/AskQuestionDialog';

interface NotesDialogProps {
  open: boolean;
  pdfPath: string;
  pdfName: string;
  onClose: () => void;
}

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function NotesDialog({ open, pdfPath, pdfName, onClose }: NotesDialogProps) {
  const { activeSessionFolder, activeSessionId } = useWorkspace();
  const [notes, setNotes] = useState<PdfNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [askNote, setAskNote] = useState<PdfNote | null>(null);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );
  const isDirty = selectedNote
    ? draftTitle !== selectedNote.title || draftContent !== selectedNote.content
    : draftTitle.trim().length > 0 || draftContent.trim().length > 0;

  useEffect(() => {
    if (!open || !pdfPath) return;

    let cancelled = false;

    const loadNotes = async () => {
      setLoading(true);
      setError('');

      try {
        const res = await fetch(`/api/workspace/notes?path=${encodeURIComponent(pdfPath)}`, { cache: 'no-store' });
        const data = await res.json();

        if (!res.ok || data?.error) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to load notes.');
        }

        if (!cancelled) {
          const loadedNotes = Array.isArray(data.notes) ? data.notes as PdfNote[] : [];
          setNotes(loadedNotes);
          setSelectedNoteId(null);
          setDraftTitle('');
          setDraftContent('');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load notes.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadNotes();

    return () => {
      cancelled = true;
    };
  }, [open, pdfPath]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const handleSelectNote = (note: PdfNote) => {
    setSelectedNoteId(note.id);
    setDraftTitle(note.title);
    setDraftContent(note.content);
    setError('');
  };

  const handleNewNote = () => {
    setSelectedNoteId(null);
    setDraftTitle('');
    setDraftContent('');
    setError('');
  };

  const handleSave = async () => {
    if (!pdfPath || saving) return;
    setSaving(true);
    setError('');

    try {
      if (selectedNote) {
        const res = await fetch('/api/workspace/notes', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfPath,
            noteId: selectedNote.id,
            title: draftTitle,
            content: draftContent,
          }),
        });
        const data = await res.json();

        if (!res.ok || data?.error) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to save note.');
        }

        const updatedNote = data.note as PdfNote;
        setNotes((current) => current.map((note) => (note.id === updatedNote.id ? updatedNote : note)));
        setDraftTitle(updatedNote.title);
        setDraftContent(updatedNote.content);
      } else {
        const res = await fetch('/api/workspace/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfPath,
            title: draftTitle,
            content: draftContent,
          }),
        });
        const data = await res.json();

        if (!res.ok || data?.error) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to create note.');
        }

        const createdNote = data.note as PdfNote;
        setNotes((current) => [createdNote, ...current]);
        setSelectedNoteId(createdNote.id);
        setDraftTitle(createdNote.title);
        setDraftContent(createdNote.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (note: PdfNote) => {
    if (deletingId) return;
    setDeletingId(note.id);
    setError('');

    try {
      const res = await fetch('/api/workspace/notes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfPath, noteId: note.id }),
      });
      const data = await res.json();

      if (!res.ok || data?.error) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to delete note.');
      }

      setNotes((current) => current.filter((item) => item.id !== note.id));
      if (selectedNoteId === note.id) {
        handleNewNote();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete note.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6">
      <div className="flex h-full max-h-[85vh] w-full max-w-5xl flex-col rounded-2xl border border-outline-variant/20 bg-surface-container-lowest shadow-ambient">
        <div className="flex items-start justify-between gap-4 border-b border-outline-variant/15 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
              <NotebookPen size={14} strokeWidth={2} />
              Notes
            </div>
            <p className="mt-1 truncate text-xs leading-5 text-on-surface-variant">{pdfName}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Note list */}
          <div className="flex w-56 shrink-0 flex-col border-r border-outline-variant/15">
            <div className="p-3">
              <button
                onClick={handleNewNote}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90"
              >
                <Plus size={13} strokeWidth={2} />
                New note
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-xs text-on-surface-variant">
                  <Loader2 size={14} className="animate-spin" />
                  Loading...
                </div>
              ) : notes.length === 0 ? (
                <div className="px-2 py-4 text-xs text-on-surface-variant">
                  No saved notes yet.
                </div>
              ) : (
                <div className="space-y-1">
                  {notes.map((note) => (
                    <div
                      key={note.id}
                      className={`group flex items-start gap-1 rounded-lg px-2 py-2 transition-colors ${
                        note.id === selectedNoteId
                          ? 'bg-surface-container-high'
                          : 'hover:bg-surface-container'
                      }`}
                    >
                      <button
                        onClick={() => handleSelectNote(note)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-xs font-medium text-on-surface">
                          {note.title || 'Untitled note'}
                        </div>
                        <div className="mt-0.5 text-[10px] text-outline">
                          {formatTimestamp(note.updatedAt)}
                        </div>
                      </button>
                      <button
                        onClick={() => setAskNote(note)}
                        className="shrink-0 rounded p-1 text-on-surface-variant opacity-0 transition-opacity hover:bg-surface-container-high group-hover:opacity-100"
                        title="Ask Question"
                      >
                        <MessageCircleQuestion size={12} strokeWidth={2} />
                      </button>
                      <button
                        onClick={() => void handleDelete(note)}
                        disabled={deletingId === note.id}
                        className="shrink-0 rounded p-1 text-on-surface-variant opacity-0 transition-opacity hover:bg-surface-container-high hover:text-error group-hover:opacity-100 disabled:opacity-50"
                        title="Delete note"
                      >
                        {deletingId === note.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} strokeWidth={2} />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Editor + preview */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-outline-variant/15 px-4 py-2.5">
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Note title"
                className="flex-1 bg-transparent text-sm font-medium text-on-surface outline-none placeholder:text-outline"
              />
              {selectedNote && (
                <button
                  onClick={() => setAskNote(selectedNote)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-high"
                >
                  <MessageCircleQuestion size={12} strokeWidth={2} />
                  Ask Question
                </button>
              )}
              <button
                onClick={() => void handleSave()}
                disabled={saving || !isDirty || (!draftTitle.trim() && !draftContent.trim())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-on-surface px-3 py-1.5 text-xs font-semibold text-surface-container-lowest transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} strokeWidth={2} />}
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>

            {error && (
              <div className="mx-4 mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
                {error}
              </div>
            )}

            <div className="flex flex-1 overflow-hidden">
              <div className="flex w-1/2 flex-col border-r border-outline-variant/15">
                <div className="px-4 pt-3 text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                  Write
                </div>
                <textarea
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.target.value)}
                  placeholder={'Write your notes here...\n\nUse $...$ for inline LaTeX and $$...$$ for block LaTeX, e.g. $$E = mc^2$$'}
                  className="flex-1 resize-none bg-transparent px-4 py-3 text-sm text-on-surface outline-none placeholder:text-outline font-editorial"
                />
              </div>
              <div className="flex w-1/2 flex-col overflow-hidden">
                <div className="px-4 pt-3 text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                  Preview
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-3">
                  {draftContent.trim() ? (
                    <div className="chat-markdown font-editorial text-sm text-on-surface">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
                          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
                          li: ({ children }) => <li>{children}</li>,
                          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                          code: ({ children, className }) => {
                            const isBlock = Boolean(className);
                            if (isBlock) {
                              return (
                                <code className="block overflow-x-auto rounded-lg bg-surface-container px-3 py-2 font-functional text-xs">
                                  {children}
                                </code>
                              );
                            }

                            return (
                              <code className="rounded bg-surface-container px-1.5 py-0.5 font-functional text-xs">
                                {children}
                              </code>
                            );
                          },
                          pre: ({ children }) => <pre className="mb-3 last:mb-0">{children}</pre>,
                          blockquote: ({ children }) => (
                            <blockquote className="mb-3 border-l-2 border-outline-variant pl-3 text-on-surface-variant last:mb-0">
                              {children}
                            </blockquote>
                          ),
                        }}
                      >
                        {normalizeMathMarkdown(draftContent)}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-xs text-on-surface-variant">
                      Preview will appear here as you type.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AskQuestionDialog
        open={askNote !== null}
        selectedText={askNote ? `${askNote.title}\n\n${askNote.content}` : ''}
        folderPath={activeSessionFolder}
        sessionId={activeSessionId}
        currentPdfPath={pdfPath}
        onClose={() => setAskNote(null)}
      />
    </div>
  );
}
