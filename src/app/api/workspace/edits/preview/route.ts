import { promises as fs } from 'fs';
import path from 'path';

import { NextRequest, NextResponse } from 'next/server';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { isValidProposalId, proposalPreviewDir } from '@/lib/pdf-edit/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PREVIEW_FILE = /^(?:before|after|context)-\d{1,5}\.png$/;

export async function GET(req: NextRequest) {
  try {
    const pdfPath = req.nextUrl.searchParams.get('path')?.trim();
    const proposalId = req.nextUrl.searchParams.get('proposal')?.trim() ?? '';
    const file = req.nextUrl.searchParams.get('file')?.trim() ?? '';

    if (!pdfPath || !isValidProposalId(proposalId) || !PREVIEW_FILE.test(file)) {
      return NextResponse.json({ error: 'path, proposal and file are required' }, { status: 400 });
    }

    const image = await fs.readFile(path.join(proposalPreviewDir(resolveFolderPath(pdfPath), proposalId), file));
    return new NextResponse(image, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Preview not found' }, { status: 404 });
  }
}
