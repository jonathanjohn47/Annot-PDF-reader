import { NextRequest, NextResponse } from 'next/server';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { applyProposal, discardProposal, prepareProposal, ProposalError } from '@/lib/pdf-edit/pipeline';
import { getEditSummary, getProposal, redoEdit, restoreOriginal, undoEdit } from '@/lib/pdf-edit/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { headers: { 'Cache-Control': 'no-store' } };

// GET ?path=<pdf>            -> edit history summary (revision, undo/redo availability, page marks)
// GET ?path=<pdf>&proposal=  -> one stored proposal (status, checks, preview list)
export async function GET(req: NextRequest) {
  try {
    const pdfPath = req.nextUrl.searchParams.get('path')?.trim();
    if (!pdfPath) return NextResponse.json({ error: 'path is required' }, { status: 400 });
    const pdfAbs = resolveFolderPath(pdfPath);

    const proposalId = req.nextUrl.searchParams.get('proposal')?.trim();
    if (proposalId) {
      const proposal = await getProposal(pdfAbs, proposalId);
      if (!proposal) return NextResponse.json({ error: 'Edit proposal not found' }, { status: 404 });
      const { revision } = await getEditSummary(pdfAbs);
      return NextResponse.json({ proposal, currentRevision: revision }, noStore);
    }

    return NextResponse.json({ summary: await getEditSummary(pdfAbs) }, noStore);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load edit history';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type EditAction = 'apply' | 'discard' | 'undo' | 'redo' | 'restore-original' | 'prepare-pull-up' | 'prepare-renumber' | 'prepare-clean';

function manualProposal(action: 'prepare-pull-up' | 'prepare-renumber' | 'prepare-clean', page: number): { userPrompt: string; raw: Record<string, unknown> } {
  if (action === 'prepare-pull-up') {
    return {
      userPrompt: `(by hand) pull the content after page ${page} up into its empty space`,
      raw: {
        intent: 'reorganise',
        summary: `Pull the content that starts page ${page + 1} up into the empty space at the bottom of page ${page}.`,
        rationale: 'Requested by hand from the viewer to remove empty space.',
        placement_rationale: `Fills the free space under the last block on page ${page}.`,
        ops: [{ type: 'pull_up', page }],
        qualification_check: 'Nothing is rewritten or removed; blocks only change position.',
      },
    };
  }
  if (action === 'prepare-renumber') {
    return {
      userPrompt: '(by hand) renumber the printed page numbers',
      raw: {
        intent: 'reorganise',
        summary: 'Renumber the printed page numbers so each page shows its own position.',
        rationale: 'Requested by hand from the viewer: pages were added, removed or moved, so the printed numbers no longer match.',
        placement_rationale: 'Only the page number in the running header or footer of each page changes.',
        ops: [{ type: 'renumber_pages' }],
        qualification_check: 'Only the printed page numbers change; no body text is touched.',
      },
    };
  }
  return {
    userPrompt: '(by hand) clean up hidden duplicate content',
    raw: {
      intent: 'reorganise',
      summary: 'Clean up the file: remove hidden duplicate copies that earlier edits left inside pages.',
      rationale: 'Earlier edits left invisible copies of page content behind, which makes pages slow to open and scroll.',
      placement_rationale: 'Only invisible content is removed; every page looks exactly the same.',
      ops: [{ type: 'clean_file' }],
      qualification_check: 'Nothing visible or readable changes.',
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    const { pdfPath, action, proposalId, page } = await req.json() as {
      pdfPath?: string;
      action?: EditAction;
      proposalId?: string;
      page?: number;
    };
    if (!pdfPath?.trim()) return NextResponse.json({ error: 'pdfPath is required' }, { status: 400 });
    const pdfAbs = resolveFolderPath(pdfPath.trim());

    switch (action) {
      case 'apply': {
        if (!proposalId) return NextResponse.json({ error: 'proposalId is required' }, { status: 400 });
        const { stored, revision } = await applyProposal(pdfAbs, proposalId);
        return NextResponse.json({ ok: true, revision, proposal: stored, summary: await getEditSummary(pdfAbs) }, noStore);
      }
      case 'prepare-pull-up':
      case 'prepare-renumber':
      case 'prepare-clean': {
        // A hand-made edit from the viewer: same checks, preview and undo as an AI proposal, but no model involved.
        if (action === 'prepare-pull-up' && (!Number.isInteger(page) || Number(page) < 1)) {
          return NextResponse.json({ error: 'page must be a positive integer' }, { status: 400 });
        }
        const manual = manualProposal(action, Number(page));
        const stored = await prepareProposal({
          pdfPath: pdfPath.trim(),
          pdfAbs,
          sessionId: 'manual',
          userPrompt: manual.userPrompt,
          raw: manual.raw,
        });
        return NextResponse.json({ ok: true, proposal: stored }, noStore);
      }
      case 'discard': {
        if (!proposalId) return NextResponse.json({ error: 'proposalId is required' }, { status: 400 });
        const stored = await discardProposal(pdfAbs, proposalId);
        return NextResponse.json({ ok: true, proposal: stored, summary: await getEditSummary(pdfAbs) }, noStore);
      }
      case 'undo':
        await undoEdit(pdfAbs);
        return NextResponse.json({ ok: true, summary: await getEditSummary(pdfAbs) }, noStore);
      case 'redo':
        await redoEdit(pdfAbs);
        return NextResponse.json({ ok: true, summary: await getEditSummary(pdfAbs) }, noStore);
      case 'restore-original':
        await restoreOriginal(pdfAbs);
        return NextResponse.json({ ok: true, summary: await getEditSummary(pdfAbs) }, noStore);
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Edit action failed';
    const proposal = error instanceof ProposalError ? error.stored : undefined;
    return NextResponse.json({ error: message, proposal }, { status: error instanceof ProposalError ? 409 : 500 });
  }
}
