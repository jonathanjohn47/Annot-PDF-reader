// Proposal lifecycle: validate -> build a preview (live PDF untouched) -> user applies or discards -> commit with history.

import { promises as fs } from 'fs';
import path from 'path';

import { buildDocumentEdit } from './python-engine.ts';
import { validateProposal } from './schema.ts';
import {
  clearProposalPreviews,
  commitCandidateLocked,
  getEditSummary,
  getProposal,
  newProposalId,
  proposalDir,
  proposalPreviewDir,
  saveProposal,
  withPdfLock,
} from './store.ts';
import type { EditProposal, EngineResult, Issue, StoredProposal } from './types.ts';

const NARROW_MAX_PAGES = 3;

// Narrow = purely additive, small, and nothing the checks wanted a human to look at.
export function isNarrow(proposal: EditProposal | null, result: EngineResult | null): boolean {
  if (!proposal || !result || !result.ok || result.destructive) return false;
  if (!proposal.ops.every((op) => op.type === 'insert_content')) return false;
  const stats = result.stats;
  if (!stats || stats.addedPages + stats.changedPages > NARROW_MAX_PAGES) return false;
  if (stats.droppedHighlights > 0 || stats.droppedAnnotations > 0) return false;
  return !result.issues.some((issue) => issue.severity !== 'info');
}

export function formatIssuesForModel(issues: Issue[]): string {
  const relevant = issues.filter((issue) => issue.severity !== 'info');
  return relevant
    .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.code}${issue.op ? ` (operation ${issue.op})` : ''}: ${issue.message}`)
    .join('\n');
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export interface PrepareInput {
  pdfPath: string;
  pdfAbs: string;
  raw: unknown;
  sessionId?: string;
  userPrompt?: string;
  /** Set when the model's block could not even be parsed as JSON. */
  parseError?: string;
}

function baseRecord(input: PrepareInput, id: string, revision: number): StoredProposal {
  const now = new Date().toISOString();
  return {
    id,
    pdfPath: input.pdfPath,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    sessionId: input.sessionId,
    userPrompt: input.userPrompt,
    proposal: null,
    issues: [],
    previews: [],
    marks: [],
    pageMap: [],
    destructive: false,
    narrow: false,
    baseRevision: revision,
  };
}

// Never writes to the live PDF. A rejected proposal keeps its reasons so the model (and the user) can see them.
export async function prepareProposal(input: PrepareInput): Promise<StoredProposal> {
  const id = newProposalId();
  const summary = await getEditSummary(input.pdfAbs);
  const record = baseRecord(input, id, summary.revision);

  if (input.parseError) {
    record.status = 'rejected';
    record.issues = [{ severity: 'error', code: 'json', message: input.parseError }];
    await saveProposal(input.pdfAbs, record);
    return record;
  }

  const validated = validateProposal(input.raw);
  if (!validated.ok) {
    record.status = 'rejected';
    record.issues = validated.errors.map((message) => ({ severity: 'error' as const, code: 'schema', message }));
    await saveProposal(input.pdfAbs, record);
    return record;
  }
  record.proposal = validated.proposal;

  let result: EngineResult;
  try {
    await fs.rm(proposalPreviewDir(input.pdfAbs, id), { recursive: true, force: true });
    result = await buildDocumentEdit(input.pdfAbs, validated.proposal, { previewDir: proposalPreviewDir(input.pdfAbs, id) });
  } catch (error) {
    record.status = 'rejected';
    record.issues = [{
      severity: 'error',
      code: 'engine_unavailable',
      message: error instanceof Error ? error.message : 'The PDF engine could not run. Is Python with PyMuPDF installed?',
    }];
    await saveProposal(input.pdfAbs, record);
    return record;
  }

  record.issues = result.issues;
  record.previews = result.previews ?? [];
  record.marks = result.marks ?? [];
  record.pageMap = result.pageMap ?? [];
  record.stats = result.stats;
  record.destructive = Boolean(result.destructive);
  record.status = result.ok ? 'pending' : 'rejected';
  record.narrow = isNarrow(validated.proposal, result);
  await saveProposal(input.pdfAbs, record);
  return record;
}

export class ProposalError extends Error {
  stored?: StoredProposal;

  constructor(message: string, stored?: StoredProposal) {
    super(message);
    this.stored = stored;
  }
}

// Rebuilds from the live file (so highlights added since the preview are kept), re-checks, then commits atomically.
export async function applyProposal(pdfAbs: string, id: string): Promise<{ stored: StoredProposal; revision: number }> {
  return withPdfLock(pdfAbs, async () => {
    const stored = await getProposal(pdfAbs, id);
    if (!stored || !stored.proposal) throw new ProposalError('That edit proposal no longer exists.');
    if (stored.status !== 'pending') throw new ProposalError(`This edit is already ${stored.status}.`, stored);

    const candidate = path.join(proposalDir(pdfAbs, id), 'candidate.pdf');
    await fs.mkdir(proposalDir(pdfAbs, id), { recursive: true });
    try {
      const result = await buildDocumentEdit(pdfAbs, stored.proposal, { outPath: candidate });
      if (!result.ok) {
        stored.status = 'stale';
        stored.issues = result.issues;
        stored.error = 'The document changed since this preview, and the edit no longer applies cleanly. Nothing was changed.';
        stored.updatedAt = new Date().toISOString();
        await saveProposal(pdfAbs, stored);
        throw new ProposalError(stored.error, stored);
      }
      const revision = await commitCandidateLocked(pdfAbs, candidate, {
        proposalId: stored.id,
        summary: stored.proposal.summary,
        rationale: stored.proposal.rationale,
        intent: stored.proposal.intent,
        opTypes: stored.proposal.ops.map((op) => op.type),
        marks: result.marks ?? [],
        pageMap: result.pageMap ?? [],
      });
      stored.status = 'applied';
      stored.appliedRevision = revision;
      stored.issues = result.issues;
      stored.marks = result.marks ?? stored.marks;
      stored.pageMap = result.pageMap ?? stored.pageMap;
      stored.stats = result.stats ?? stored.stats;
      stored.error = undefined;
      stored.updatedAt = new Date().toISOString();
      await saveProposal(pdfAbs, stored);
      return { stored, revision };
    } catch (error) {
      if (error instanceof ProposalError) throw error;
      // The commit failed part-way; the store has already restored the previous live file.
      stored.error = error instanceof Error ? error.message : 'The edit could not be applied.';
      stored.updatedAt = new Date().toISOString();
      await saveProposal(pdfAbs, stored);
      throw new ProposalError(`${stored.error} The PDF was left unchanged.`, stored);
    } finally {
      await fs.rm(candidate, { force: true });
    }
  });
}

export async function discardProposal(pdfAbs: string, id: string): Promise<StoredProposal> {
  const stored = await getProposal(pdfAbs, id);
  if (!stored) throw new ProposalError('That edit proposal no longer exists.');
  if (stored.status === 'applied') throw new ProposalError('This edit is already applied; use Undo to take it back.', stored);
  stored.status = 'discarded';
  stored.updatedAt = new Date().toISOString();
  await saveProposal(pdfAbs, stored);
  await clearProposalPreviews(pdfAbs, id);
  return stored;
}
