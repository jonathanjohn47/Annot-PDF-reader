// Glue between a chat turn and the edit pipeline: decides whether editing is allowed, gives the model its
// document context, and turns the model's edit block into a validated proposal (with a bounded repair loop).

import { resolveFolderPath } from '@/lib/annot-sessions';
import { isPdfPath } from '@/lib/document-types';
import { getPythonCommand } from '@/lib/python-runtime';
import type { ProviderRuntime, ProviderTurnEvent, ProviderTurnInput } from '@/lib/ai-providers/types';
import type { AIProvider } from '@/types';

import { detectEditIntent, extractEditDirective } from './directive.ts';
import type { EditPromptContext } from './edit-prompt.ts';
import {
  applyProposal,
  formatIssuesForModel,
  hasErrors,
  prepareProposal,
  ProposalError,
} from './pipeline.ts';
import { getDocumentMap, getEngineScriptPath } from './python-engine.ts';
import { getEditSummary } from './store.ts';
import type { StoredProposal } from './types.ts';

const MAX_REPAIR_ROUNDS = 3;

export interface EditContextResult {
  allowed: boolean;
  reason: string;
  prompt: EditPromptContext;
  pdfAbs: string | null;
}

function describePages(marks: Array<{ page: number }>): string {
  const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);
  return pages.length === 0 ? 'no pages' : `page${pages.length > 1 ? 's' : ''} ${pages.join(', ')}`;
}

export async function buildEditContext(input: {
  pdfPath: string | null;
  provider: AIProvider;
  prompt: string;
  editMode: boolean;
}): Promise<EditContextResult> {
  if (!input.pdfPath) return { allowed: false, reason: 'no PDF is open', prompt: { allowed: false }, pdfAbs: null };
  if (!isPdfPath(input.pdfPath)) return { allowed: false, reason: 'editing is only available for PDF files', prompt: { allowed: false }, pdfAbs: null };
  if (input.provider === 'ollama') {
    return { allowed: false, reason: 'local Ollama models cannot read the PDF tools needed for editing', prompt: { allowed: false }, pdfAbs: null };
  }

  const intent = detectEditIntent(input.prompt);
  if (!input.editMode && !intent.explicit) {
    return { allowed: false, reason: intent.reason, prompt: { allowed: false }, pdfAbs: null };
  }

  const pdfAbs = resolveFolderPath(input.pdfPath);
  const [map, summary, python] = await Promise.all([
    getDocumentMap(pdfAbs).catch(() => null),
    getEditSummary(pdfAbs).catch(() => null),
    getPythonCommand().catch(() => null),
  ]);

  const applied = summary?.entries.filter((entry) => entry.applied) ?? [];
  const revisionNote = summary
    ? `Document revision ${summary.revision}${applied.length ? `. Edits already applied by Annot: ${applied.slice(-5).map((e) => `rev ${e.revision} "${e.summary}" (${describePages(e.marks)})`).join('; ')}. Pages you read earlier may have shifted; re-read what you need.` : ' (no edits applied yet).'}`
    : undefined;

  return {
    allowed: true,
    reason: input.editMode ? 'edit mode is on' : intent.reason,
    pdfAbs,
    prompt: {
      allowed: true,
      pdfAbsPath: pdfAbs,
      scriptPath: getEngineScriptPath(),
      pythonCommand: python ? [python.command, ...python.argsPrefix].join(' ') : 'python3',
      documentMap: map?.text,
      revisionNote,
    },
  };
}

export interface ProcessEditInput {
  content: string;
  providerSessionId: string;
  edit: EditContextResult;
  pdfPath: string;
  sessionId: string;
  userPrompt: string;
  autoApplyNarrow: boolean;
  runtime: ProviderRuntime;
  turnInput: Omit<ProviderTurnInput, 'prompt' | 'providerSessionId'>;
  onEvent: (event: ProviderTurnEvent) => void;
}

export interface ProcessEditResult {
  content: string;
  providerSessionId: string;
  proposalId?: string;
}

function repairPrompt(stored: StoredProposal): string {
  return [
    'Annot checked your PDF edit proposal and could not accept it yet. Nothing in the PDF was changed.',
    'Problems found:',
    formatIssuesForModel(stored.issues),
    'Fix exactly these problems and reply with one short line saying what you corrected, then the complete corrected edit block (same format). Re-read the PDF with the helper where a quote or number was wrong. Do not change anything that was not a problem. If the edit cannot be made correctly, reply without an edit block and explain in one line why.',
  ].join('\n');
}

function plainReasons(stored: StoredProposal): string {
  return stored.issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => `- ${i.message}`).join('\n');
}

export async function processEditReply(input: ProcessEditInput): Promise<ProcessEditResult> {
  const extracted = extractEditDirective(input.content);
  if (!extracted.found) return { content: input.content, providerSessionId: input.providerSessionId };

  if (!input.edit.allowed || !input.edit.pdfAbs) {
    // The model proposed an edit although the user did not ask for one: ignore it, tell the user how to opt in.
    const note = 'I have a change to the PDF in mind, but you have not asked me to edit it. Say "add this to the PDF", or turn on Edit mode, and I will prepare it with a preview.';
    return { content: [extracted.cleanedContent, note].filter(Boolean).join('\n\n'), providerSessionId: input.providerSessionId };
  }

  const pdfAbs = input.edit.pdfAbs;
  let current = extracted;
  let sessionId = input.providerSessionId;
  let stored: StoredProposal | null = null;

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round += 1) {
    input.onEvent({ type: 'status', message: round === 0 ? 'Checking the proposed PDF edit...' : 'Correcting the proposed PDF edit...' });
    stored = await prepareProposal({
      pdfPath: input.pdfPath,
      pdfAbs,
      raw: current.parsed,
      parseError: current.parseError,
      sessionId: input.sessionId,
      userPrompt: input.userPrompt,
    });
    if (stored.status === 'pending' || round === MAX_REPAIR_ROUNDS || !hasErrors(stored.issues)) break;

    const repair = await input.runtime.runTurn(
      {
        ...input.turnInput,
        providerSessionId: sessionId,
        selectedText: null,
        screenshotPaths: [],
        attachmentPaths: [],
        prompt: repairPrompt(stored),
      },
      { onEvent: input.onEvent },
    );
    sessionId = repair.providerSessionId || sessionId;
    current = extractEditDirective(repair.content);
    if (!current.found) break;
  }

  const visible = extracted.cleanedContent;
  if (!stored) return { content: visible, providerSessionId: sessionId };

  if (stored.status !== 'pending') {
    const note = `I could not prepare a valid edit for the PDF, so nothing was changed.\n${plainReasons(stored) || '- The proposal could not be checked.'}`;
    return { content: [visible, note].filter(Boolean).join('\n\n'), providerSessionId: sessionId, proposalId: stored.id };
  }

  if (stored.narrow && input.autoApplyNarrow) {
    try {
      const { revision } = await applyProposal(pdfAbs, stored.id);
      return {
        content: [visible, `Applied to the PDF as revision ${revision}. You can undo it from the edit history.`].filter(Boolean).join('\n\n'),
        providerSessionId: sessionId,
        proposalId: stored.id,
      };
    } catch (error) {
      const reason = error instanceof ProposalError || error instanceof Error ? error.message : 'It could not be applied.';
      return {
        content: [visible, `The edit was prepared but could not be applied: ${reason}`].filter(Boolean).join('\n\n'),
        providerSessionId: sessionId,
        proposalId: stored.id,
      };
    }
  }

  return {
    content: [visible, 'The edit is ready as a preview below. Nothing in the PDF changes until you apply it.'].filter(Boolean).join('\n\n'),
    providerSessionId: sessionId,
    proposalId: stored.id,
  };
}
