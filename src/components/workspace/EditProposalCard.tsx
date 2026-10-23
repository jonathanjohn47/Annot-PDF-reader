'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, FilePlus2, Info, Loader2, Undo2, X } from 'lucide-react';

import { describeOp } from '@/lib/pdf-edit/describe';
import type { Issue, PreviewImage, StoredProposal } from '@/lib/pdf-edit/types';
import { useWorkspace } from '@/lib/workspace-store';

interface Props {
  pdfPath: string;
  proposalId: string;
}

const STATUS_LABEL: Record<StoredProposal['status'], string> = {
  pending: 'Waiting for your review',
  applied: 'Applied',
  discarded: 'Discarded',
  rejected: 'Not applied',
  stale: 'Out of date',
};

const KIND_STYLE: Record<PreviewImage['kind'], { ring: string; tag: string }> = {
  added: { ring: 'ring-2 ring-emerald-500/70', tag: 'New' },
  changed: { ring: 'ring-2 ring-amber-500/70', tag: 'Changed' },
  deleted: { ring: 'ring-2 ring-red-500/70', tag: 'Removed' },
  orig: { ring: 'ring-1 ring-outline-variant/40', tag: '' },
};

function previewUrl(pdfPath: string, proposalId: string, file: string): string {
  return `/api/workspace/edits/preview?path=${encodeURIComponent(pdfPath)}&proposal=${encodeURIComponent(proposalId)}&file=${encodeURIComponent(file)}`;
}

function IssueList({ issues, tone }: { issues: Issue[]; tone: 'error' | 'warning' | 'info' }) {
  if (issues.length === 0) return null;
  const color = tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-amber-700' : 'text-on-surface-variant';
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <ul className="mt-1.5 space-y-1">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className={`flex gap-1.5 text-[11px] leading-snug ${color}`}>
          <Icon size={11} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function EditProposalCard({ pdfPath, proposalId }: Props) {
  const { notifyPdfEdited } = useWorkspace();
  const [proposal, setProposal] = useState<StoredProposal | null>(null);
  const [currentRevision, setCurrentRevision] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'apply' | 'discard' | 'undo' | null>(null);
  const [actionError, setActionError] = useState('');
  const [zoomed, setZoomed] = useState<PreviewImage | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/edits?path=${encodeURIComponent(pdfPath)}&proposal=${encodeURIComponent(proposalId)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'Could not load this edit.');
      setProposal(data.proposal as StoredProposal);
      setCurrentRevision(typeof data.currentRevision === 'number' ? data.currentRevision : null);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load this edit.');
    }
  }, [pdfPath, proposalId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (action: 'apply' | 'discard' | 'undo') => {
    setBusy(action);
    setActionError('');
    try {
      const res = await fetch('/api/workspace/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfPath, action, proposalId }),
      });
      const data = await res.json();
      if (data?.proposal) setProposal(data.proposal as StoredProposal);
      if (!res.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'The action failed.');
      if (action === 'apply') {
        const firstPage = (data.proposal as StoredProposal).marks[0]?.page;
        setCurrentRevision((data.proposal as StoredProposal).appliedRevision ?? null);
        notifyPdfEdited(firstPage);
      } else if (action === 'undo') {
        notifyPdfEdited();
        await load();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return <div className="mt-2 rounded-xl bg-surface-container px-3 py-2 text-[11px] text-on-surface-variant">PDF edit details are not available ({loadError}).</div>;
  }
  if (!proposal) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-surface-container px-3 py-2 text-[11px] text-on-surface-variant">
        <Loader2 size={11} className="animate-spin" /> Loading PDF edit...
      </div>
    );
  }

  const errors = proposal.issues.filter((i) => i.severity === 'error');
  const warnings = proposal.issues.filter((i) => i.severity === 'warning');
  const infos = proposal.issues.filter((i) => i.severity === 'info');
  const needsReview = proposal.destructive || !proposal.narrow;
  const undone = proposal.status === 'applied' && currentRevision !== null && proposal.appliedRevision !== undefined && currentRevision < proposal.appliedRevision;
  const previews = proposal.previews;
  const before = previews.filter((p) => p.role === 'before');
  const after = previews.filter((p) => p.role !== 'before');

  return (
    <div className="mt-2 rounded-xl border border-outline-variant/30 bg-surface-container-low px-3 py-2.5" data-testid="edit-proposal-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-on-surface">
          <FilePlus2 size={12} strokeWidth={2} /> PDF edit
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            proposal.status === 'applied' ? 'bg-emerald-100 text-emerald-800'
              : proposal.status === 'pending' ? 'bg-amber-100 text-amber-800'
                : 'bg-surface-container-high text-on-surface-variant'
          }`}
        >
          {undone ? 'Applied, then undone' : STATUS_LABEL[proposal.status]}
          {proposal.status === 'applied' && proposal.appliedRevision && !undone ? ` · revision ${proposal.appliedRevision}` : ''}
        </span>
      </div>

      {proposal.proposal && (
        <div className="mt-1.5 text-xs text-on-surface">
          <div className="font-medium">{proposal.proposal.summary}</div>
          <div className="mt-1 text-[11px] text-on-surface-variant"><b>Why:</b> {proposal.proposal.rationale}</div>
          <div className="mt-0.5 text-[11px] text-on-surface-variant"><b>Why here:</b> {proposal.proposal.placement_rationale}</div>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-on-surface">
            {proposal.proposal.ops.map((op, index) => <li key={index}>{describeOp(op)}</li>)}
          </ul>
          {proposal.proposal.simplifications.length > 0 && (
            <div className="mt-1 text-[11px] text-on-surface-variant"><b>Simplified:</b> {proposal.proposal.simplifications.join(' ')}</div>
          )}
        </div>
      )}

      {proposal.stats && (
        <div className="mt-1.5 text-[11px] text-on-surface-variant">
          {proposal.stats.pagesBefore} → {proposal.stats.pagesAfter} pages
          {proposal.stats.addedPages > 0 ? ` · ${proposal.stats.addedPages} new` : ''}
          {proposal.stats.changedPages > 0 ? ` · ${proposal.stats.changedPages} changed` : ''}
          {proposal.stats.droppedHighlights > 0 ? ` · ${proposal.stats.droppedHighlights} highlight(s) on replaced text removed` : ''}
        </div>
      )}

      <IssueList issues={errors} tone="error" />
      <IssueList issues={warnings} tone="warning" />
      {infos.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-on-surface-variant">{infos.length} note{infos.length > 1 ? 's' : ''} for your review</summary>
          <IssueList issues={infos} tone="info" />
        </details>
      )}

      {previews.length > 0 && proposal.status !== 'discarded' && (
        <div className="mt-2 space-y-2">
          {before.length > 0 && <div className="text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">Before</div>}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {before.map((p) => (
              <button key={`${p.role}-${p.file}`} onClick={() => setZoomed(p)} className="shrink-0 text-left">
                <img src={previewUrl(pdfPath, proposal.id, p.file)} alt={p.label} className={`h-28 rounded bg-white ${KIND_STYLE[p.kind].ring}`} />
                <div className="mt-0.5 text-[10px] text-on-surface-variant">{p.label}</div>
              </button>
            ))}
          </div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">After (green = new text)</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {after.map((p) => (
              <button key={`${p.role}-${p.file}`} onClick={() => setZoomed(p)} className="shrink-0 text-left">
                <img src={previewUrl(pdfPath, proposal.id, p.file)} alt={p.label} className={`h-28 rounded bg-white ${KIND_STYLE[p.kind].ring} ${p.role === 'context' ? 'opacity-70' : ''}`} />
                <div className="mt-0.5 text-[10px] text-on-surface-variant">
                  {p.role === 'context' ? `Context · page ${p.page}` : p.label}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {proposal.status === 'pending' && (
        <>
          {needsReview && (
            <div className="mt-2 text-[11px] text-on-surface-variant">
              Please review: this edit {proposal.destructive ? 'removes or revises existing material' : 'is larger than a small addition'}. You can undo it afterwards.
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void act('apply')}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-on-surface px-3 py-1.5 text-[11px] font-semibold text-surface-container-lowest hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'apply' ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} strokeWidth={2.5} />}
              Apply to PDF
            </button>
            <button
              onClick={() => void act('discard')}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
            >
              {busy === 'discard' ? <Loader2 size={11} className="animate-spin" /> : <X size={11} strokeWidth={2.5} />}
              Discard
            </button>
          </div>
        </>
      )}
      {proposal.status === 'applied' && undone && (
        <div className="mt-2 text-[10px] text-on-surface-variant">This edit was undone. Use Redo in the PDF toolbar&apos;s edit history to bring it back.</div>
      )}
      {proposal.status === 'applied' && !undone && (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => void act('undo')}
            disabled={busy !== null || (currentRevision !== null && proposal.appliedRevision !== currentRevision)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
          >
            {busy === 'undo' ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} strokeWidth={2.5} />}
            Undo
          </button>
          <span className="text-[10px] text-on-surface-variant">The original stays recoverable from the PDF toolbar (edit history).</span>
        </div>
      )}
      {proposal.error && <div className="mt-2 text-[11px] text-error">{proposal.error}</div>}
      {actionError && <div className="mt-2 text-[11px] text-error">{actionError}</div>}

      {zoomed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={() => setZoomed(null)}>
          <div className="max-h-full overflow-auto rounded-xl bg-surface-container-lowest p-3 shadow-ambient" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between text-xs text-on-surface">
              <span>{zoomed.label}{zoomed.role === 'context' ? ' (unchanged, for context)' : ''}</span>
              <button onClick={() => setZoomed(null)} aria-label="Close preview"><X size={14} /></button>
            </div>
            <img src={previewUrl(pdfPath, proposal.id, zoomed.file)} alt={zoomed.label} className="max-h-[80vh] w-auto" />
          </div>
        </div>
      )}
    </div>
  );
}
