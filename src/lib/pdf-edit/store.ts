// Edit history for one PDF: a recoverable baseline, one full snapshot per revision, undo/redo, pending proposals.
//
// Layout, next to the PDF:  .annot/edits/<pdf name>/
//   history.json            which snapshot is live, and what each revision was
//   states/s0000.pdf        the document exactly as it was before the first edit (never overwritten by an edit)
//   states/s0001.pdf ...    the document after each committed edit
//   proposals/<id>/         proposal.json + preview images (nothing here ever touches the live PDF)
//
// The live PDF is only ever replaced by an atomic rename of a fully written, re-opened-and-checked file.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

import { validatePdfFile } from './python-engine.ts';
import type {
  EditState,
  EditSummary,
  HistoryEntry,
  HistoryFile,
  PageMark,
  StoredProposal,
} from './types.ts';

const locks = new Map<string, Promise<unknown>>();

// One edit at a time per PDF, so two commits can never interleave their file swaps.
export async function withPdfLock<T>(pdfAbs: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(pdfAbs) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  locks.set(pdfAbs, run);
  try {
    return await run;
  } finally {
    if (locks.get(pdfAbs) === run) locks.delete(pdfAbs);
  }
}

export function editsDir(pdfAbs: string): string {
  const safe = path.basename(pdfAbs).replace(/[^\w.-]+/g, '_');
  return path.join(path.dirname(pdfAbs), '.annot', 'edits', safe);
}

const statesDir = (pdfAbs: string) => path.join(editsDir(pdfAbs), 'states');
const historyFile = (pdfAbs: string) => path.join(editsDir(pdfAbs), 'history.json');
export const proposalDir = (pdfAbs: string, id: string) => path.join(editsDir(pdfAbs), 'proposals', id);
export const proposalPreviewDir = (pdfAbs: string, id: string) => path.join(proposalDir(pdfAbs, id), 'previews');

export function isValidProposalId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,48}$/.test(id);
}

export function newProposalId(): string {
  return `p${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(dest: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, dest);
}

// Copy to a sibling temp file, then rename: readers see the old file or the complete new one, never a partial one.
export async function copyAtomic(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.annot-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

const emptyHistory = (): HistoryFile => ({ version: 1, current: 0, states: [] });

export async function readHistory(pdfAbs: string): Promise<HistoryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyFile(pdfAbs), 'utf8')) as HistoryFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.states) && typeof parsed.current === 'number') return parsed;
  } catch {
    // no history yet
  }
  return emptyHistory();
}

async function writeHistory(pdfAbs: string, history: HistoryFile): Promise<void> {
  await writeFileAtomic(historyFile(pdfAbs), JSON.stringify(history, null, 2));
}

const stateFileName = (revision: number) => `s${String(revision).padStart(4, '0')}.pdf`;

export async function getEditSummary(pdfAbs: string): Promise<EditSummary> {
  const history = await readHistory(pdfAbs);
  const current = history.states.length === 0 ? 0 : history.current;
  return {
    revision: current,
    canUndo: current > 0,
    canRedo: history.states.length > 0 && current < history.states.length - 1,
    hasOriginal: history.states.length > 0,
    marks: history.states[current]?.marks ?? [],
    entries: history.states
      .filter((state): state is EditState & { entry: HistoryEntry } => state.entry !== null)
      .map((state) => ({ ...state.entry, applied: state.revision <= current })),
  };
}

export function remapMarks(marks: PageMark[], pageMap: Array<{ original: number; current: number }>): PageMark[] {
  if (pageMap.length === 0) return marks;
  const map = new Map(pageMap.map((m) => [m.original, m.current]));
  return marks.flatMap((mark) => {
    const next = map.get(mark.page);
    return next === undefined ? [] : [{ ...mark, page: next }];
  });
}

export interface CommitMeta {
  proposalId: string;
  summary: string;
  rationale: string;
  intent: HistoryEntry['intent'];
  opTypes: string[];
  marks: PageMark[];
  pageMap: Array<{ original: number; current: number }>;
}

// Makes `candidatePath` the live PDF as a new revision. Either everything succeeds or the live file is untouched.
// Caller must hold the PDF lock (withPdfLock) so the candidate is still based on the live file.
export async function commitCandidateLocked(pdfAbs: string, candidatePath: string, meta: CommitMeta): Promise<number> {
  {
    const history = await readHistory(pdfAbs);
    await fs.mkdir(statesDir(pdfAbs), { recursive: true });

    if (history.states.length === 0) {
      const live = await validatePdfFile(pdfAbs);
      if (!live.ok) throw new Error('The current PDF could not be read, so it was not edited.');
      await copyAtomic(pdfAbs, path.join(statesDir(pdfAbs), stateFileName(0)));
      history.states.push({ revision: 0, file: stateFileName(0), entry: null, marks: [], pageCount: live.pageCount ?? 0 });
      history.current = 0;
    } else {
      // A new edit after an undo discards the redo branch.
      for (const dropped of history.states.slice(history.current + 1)) {
        await fs.rm(path.join(statesDir(pdfAbs), dropped.file), { force: true });
      }
      history.states = history.states.slice(0, history.current + 1);
    }

    const revision = history.states.length;
    const file = stateFileName(revision);
    const statePath = path.join(statesDir(pdfAbs), file);
    await copyAtomic(candidatePath, statePath);

    const check = await validatePdfFile(statePath);
    if (!check.ok) {
      await fs.rm(statePath, { force: true });
      throw new Error(`The edited PDF failed its integrity check, so it was not applied${check.error ? `: ${check.error}` : '.'}`);
    }

    const backup = path.join(statesDir(pdfAbs), 'pre-commit.bak');
    await copyAtomic(pdfAbs, backup);
    try {
      await copyAtomic(statePath, pdfAbs);
    } catch (error) {
      await fs.rm(statePath, { force: true });
      await fs.rm(backup, { force: true });
      throw error;
    }

    const previousMarks = history.states[history.current]?.marks ?? [];
    const entry: HistoryEntry = {
      revision,
      proposalId: meta.proposalId,
      at: new Date().toISOString(),
      summary: meta.summary,
      rationale: meta.rationale,
      intent: meta.intent,
      opTypes: meta.opTypes,
      marks: meta.marks,
    };
    history.states.push({
      revision,
      file,
      entry,
      marks: [...remapMarks(previousMarks, meta.pageMap), ...meta.marks],
      pageCount: check.pageCount ?? 0,
    });
    history.current = revision;

    try {
      await writeHistory(pdfAbs, history);
    } catch (error) {
      // History could not be recorded: put the previous document back rather than leave an untracked change.
      await copyAtomic(backup, pdfAbs);
      await fs.rm(statePath, { force: true });
      await fs.rm(backup, { force: true });
      throw error;
    }
    await fs.rm(backup, { force: true });
    return revision;
  }
}

export function commitCandidate(pdfAbs: string, candidatePath: string, meta: CommitMeta): Promise<number> {
  return withPdfLock(pdfAbs, () => commitCandidateLocked(pdfAbs, candidatePath, meta));
}

async function switchTo(pdfAbs: string, history: HistoryFile, target: number): Promise<number> {
  const dir = statesDir(pdfAbs);
  const currentState = history.states[history.current];
  const targetState = history.states[target];
  const targetPath = path.join(dir, targetState.file);
  if (!(await exists(targetPath))) throw new Error('That earlier version is missing from the edit history.');
  const check = await validatePdfFile(targetPath);
  if (!check.ok) throw new Error('That earlier version failed its integrity check, so nothing was changed.');

  // Keep highlights added since the last edit with the revision we are leaving, so redo brings them back.
  await copyAtomic(pdfAbs, path.join(dir, currentState.file));
  await copyAtomic(targetPath, pdfAbs);
  history.current = target;
  await writeHistory(pdfAbs, history);
  return target;
}

export async function undoEdit(pdfAbs: string): Promise<number> {
  return withPdfLock(pdfAbs, async () => {
    const history = await readHistory(pdfAbs);
    if (history.states.length === 0 || history.current <= 0) throw new Error('There is nothing to undo.');
    return switchTo(pdfAbs, history, history.current - 1);
  });
}

export async function redoEdit(pdfAbs: string): Promise<number> {
  return withPdfLock(pdfAbs, async () => {
    const history = await readHistory(pdfAbs);
    if (history.states.length === 0 || history.current >= history.states.length - 1) throw new Error('There is nothing to redo.');
    return switchTo(pdfAbs, history, history.current + 1);
  });
}

export async function restoreOriginal(pdfAbs: string): Promise<number> {
  return withPdfLock(pdfAbs, async () => {
    const history = await readHistory(pdfAbs);
    if (history.states.length === 0 || history.current === 0) throw new Error('The PDF is already the original.');
    return switchTo(pdfAbs, history, 0);
  });
}

// ── proposals ──────────────────────────────────────────────────────────────

export async function saveProposal(pdfAbs: string, stored: StoredProposal): Promise<void> {
  await writeFileAtomic(path.join(proposalDir(pdfAbs, stored.id), 'proposal.json'), JSON.stringify(stored, null, 2));
}

export async function getProposal(pdfAbs: string, id: string): Promise<StoredProposal | null> {
  if (!isValidProposalId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(proposalDir(pdfAbs, id), 'proposal.json'), 'utf8')) as StoredProposal;
  } catch {
    return null;
  }
}

export async function clearProposalPreviews(pdfAbs: string, id: string): Promise<void> {
  if (isValidProposalId(id)) await fs.rm(proposalPreviewDir(pdfAbs, id), { recursive: true, force: true });
}
