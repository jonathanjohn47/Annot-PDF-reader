import { NextRequest, NextResponse } from 'next/server';

import {
  createPdfNote,
  deletePdfNote,
  listPdfNotes,
  updatePdfNote,
} from '@/lib/pdf-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const pdfPath = req.nextUrl.searchParams.get('path')?.trim();
    if (!pdfPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    const notes = await listPdfNotes(pdfPath);
    return NextResponse.json({ notes }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load notes';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pdfPath, title, content } = body as {
      pdfPath?: string;
      title?: string;
      content?: string;
    };

    if (!pdfPath?.trim()) {
      return NextResponse.json({ error: 'pdfPath is required' }, { status: 400 });
    }

    const note = await createPdfNote(pdfPath.trim(), title ?? '', content ?? '');
    return NextResponse.json({ note }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { pdfPath, noteId, title, content } = body as {
      pdfPath?: string;
      noteId?: string;
      title?: string;
      content?: string;
    };

    if (!pdfPath?.trim()) {
      return NextResponse.json({ error: 'pdfPath is required' }, { status: 400 });
    }

    if (!noteId?.trim()) {
      return NextResponse.json({ error: 'noteId is required' }, { status: 400 });
    }

    const note = await updatePdfNote(pdfPath.trim(), noteId.trim(), { title, content });
    return NextResponse.json({ note }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { pdfPath, noteId } = body as {
      pdfPath?: string;
      noteId?: string;
    };

    if (!pdfPath?.trim()) {
      return NextResponse.json({ error: 'pdfPath is required' }, { status: 400 });
    }

    if (!noteId?.trim()) {
      return NextResponse.json({ error: 'noteId is required' }, { status: 400 });
    }

    await deletePdfNote(pdfPath.trim(), noteId.trim());
    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete note';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
