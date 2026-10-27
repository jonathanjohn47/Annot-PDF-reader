import { NextRequest, NextResponse } from 'next/server';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { isDocxPath } from '@/lib/document-types';
import { getDocxHtml, PandocMissingError } from '@/lib/docx-convert';
import { countBackups, parseEditBlocks, saveDocxEdit, undoDocxSave } from '@/lib/docx-edit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET ?path=<file.docx> -> { html, title }: the document as HTML for the viewer (images embedded)
export async function GET(req: NextRequest) {
  try {
    const relativePath = req.nextUrl.searchParams.get('path')?.trim();
    if (!relativePath || !isDocxPath(relativePath)) {
      return NextResponse.json({ error: 'path must point to a .docx file' }, { status: 400 });
    }
    const docxAbs = resolveFolderPath(relativePath);
    const converted = await getDocxHtml(docxAbs);
    return NextResponse.json({ ...converted, backups: await countBackups(docxAbs) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open the Word file';
    const status = error instanceof PandocMissingError ? 501 : /ENOENT|not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// PUT { path, blocks } -> saves a hand edit (the previous version is kept); PUT { path, action: 'undo' } -> restores it
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json() as { path?: string; blocks?: unknown; action?: string };
    const relativePath = body.path?.trim();
    if (!relativePath || !isDocxPath(relativePath)) {
      return NextResponse.json({ error: 'path must point to a .docx file' }, { status: 400 });
    }
    const docxAbs = resolveFolderPath(relativePath);
    if (body.action === 'undo') {
      const restored = await undoDocxSave(docxAbs);
      if (!restored) return NextResponse.json({ error: 'There is no earlier version to go back to.' }, { status: 404 });
      return NextResponse.json({ ok: true, backups: await countBackups(docxAbs) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const result = await saveDocxEdit(docxAbs, parseEditBlocks(body.blocks));
    return NextResponse.json({ ok: true, ...result, backups: await countBackups(docxAbs) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save the Word file';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
