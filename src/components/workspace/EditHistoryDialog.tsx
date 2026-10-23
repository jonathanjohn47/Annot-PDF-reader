'use client';

import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, Redo2, RotateCcw, Undo2, X } from 'lucide-react';

import type { EditSummary } from '@/lib/pdf-edit/types';

interface Props {
  open: boolean;
  pdfPath: string;
  pdfName: string;
  revisionKey: number;
  onClose: () => void;
  onChanged: () => void;
  onGoToPage: (page: number) => void;
}

type Action = 'undo' | 'redo' | 'restore-original';

export function EditHistoryDialog({ open, pdfPath, pdfName, revisionKey, onClose, onChanged, onGoToPage }: Props) {
  const [summary, setSummary] = useState<EditSummary | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [confirmRestore, setConfirmRestore] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/edits?path=${encodeURIComponent(pdfPath)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'Could not load the edit history.');
      setSummary(data.summary as EditSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the edit history.');
    }
  }, [pdfPath]);

  useEffect(() => {
    if (open) {
      setError('');
      setConfirmRestore(false);
      void load();
    }
  }, [open, load, revisionKey]);

  if (!open) return null;

  const run = async (action: Action) => {
    setBusy(action);
    setError('');
    try {
      const res = await fetch('/api/workspace/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfPath, action }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'The action failed.');
      setSummary(data.summary as EditSummary);
      setConfirmRestore(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  };

  const entries = summary ? [...summary.entries].reverse() : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6">
      <div className="flex max-h-full w-full max-w-xl flex-col rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-5 shadow-ambient">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-on-surface"><History size={14} /> Edit history</div>
            <p className="mt-1 truncate text-xs text-on-surface-variant">{pdfName}</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-high" aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => void run('undo')} disabled={!summary?.canUndo || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-high disabled:opacity-40">
            {busy === 'undo' ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Undo
          </button>
          <button onClick={() => void run('redo')} disabled={!summary?.canRedo || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-high disabled:opacity-40">
            {busy === 'redo' ? <Loader2 size={12} className="animate-spin" /> : <Redo2 size={12} />} Redo
          </button>
          {!confirmRestore ? (
            <button onClick={() => setConfirmRestore(true)} disabled={!summary?.canUndo || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-high disabled:opacity-40">
              <RotateCcw size={12} /> Restore original
            </button>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-lg bg-surface-container px-3 py-1.5 text-xs">
              Go back to the PDF as it was before any edit?
              <button onClick={() => void run('restore-original')} disabled={busy !== null} className="font-semibold text-on-surface underline">
                {busy === 'restore-original' ? 'Restoring...' : 'Yes, restore'}
              </button>
              <button onClick={() => setConfirmRestore(false)} className="text-on-surface-variant">Cancel</button>
            </span>
          )}
        </div>

        <div className="mt-3 min-h-[3rem] flex-1 overflow-y-auto">
          {!summary ? (
            <div className="flex items-center gap-2 text-xs text-on-surface-variant"><Loader2 size={12} className="animate-spin" /> Loading...</div>
          ) : entries.length === 0 ? (
            <p className="text-xs text-on-surface-variant">No edits yet. This PDF is the original.</p>
          ) : (
            <ol className="space-y-2">
              {entries.map((entry) => {
                const pages = [...new Set(entry.marks.map((m) => m.page))].sort((a, b) => a - b);
                return (
                  <li key={entry.revision} className={`rounded-xl border border-outline-variant/20 px-3 py-2 ${entry.applied ? '' : 'opacity-50'}`}>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-on-surface-variant">
                      <span>Revision {entry.revision}{entry.applied ? '' : ' · undone'} · {new Date(entry.at).toLocaleString()}</span>
                      {entry.applied && entry.revision === summary.revision && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">current</span>}
                    </div>
                    <div className="mt-0.5 text-xs font-medium text-on-surface">{entry.summary}</div>
                    <div className="mt-0.5 text-[11px] text-on-surface-variant">{entry.rationale}</div>
                    {pages.length > 0 && entry.applied && (
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-on-surface-variant">
                        Pages:
                        {pages.slice(0, 8).map((p) => (
                          <button key={p} onClick={() => { onGoToPage(p); onClose(); }} className="rounded bg-surface-container px-1.5 py-0.5 hover:bg-surface-container-high">{p}</button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        {error && <p className="mt-2 text-xs text-error">{error}</p>}
        <p className="mt-3 text-[11px] text-on-surface-variant">
          The original is always kept. Highlights you add after an edit stay with that revision; undo returns the document as it was then.
        </p>
      </div>
    </div>
  );
}
