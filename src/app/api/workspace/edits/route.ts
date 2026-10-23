import { NextRequest, NextResponse } from 'next/server';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { applyProposal, discardProposal, ProposalError } from '@/lib/pdf-edit/pipeline';
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

type EditAction = 'apply' | 'discard' | 'undo' | 'redo' | 'restore-original';

export async function POST(req: NextRequest) {
  try {
    const { pdfPath, action, proposalId } = await req.json() as {
      pdfPath?: string;
      action?: EditAction;
      proposalId?: string;
    };
    if (!pdfPath?.trim()) return NextResponse.json({ error: 'pdfPath is required' }, { status: 400 });
    const pdfAbs = resolveFolderPath(pdfPath.trim());

    switch (action) {
      case 'apply': {
        if (!proposalId) return NextResponse.json({ error: 'proposalId is required' }, { status: 400 });
        const { stored, revision } = await applyProposal(pdfAbs, proposalId);
        return NextResponse.json({ ok: true, revision, proposal: stored, summary: await getEditSummary(pdfAbs) }, noStore);
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
