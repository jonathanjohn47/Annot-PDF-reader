import { promises as fs } from 'fs';
import path from 'path';

import { NextRequest, NextResponse } from 'next/server';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { isDocxPath } from '@/lib/document-types';
import { docxSidecarPath } from '@/lib/docx-convert';
import type { DocxHighlight } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HIGHLIGHTS = 5000;
const noStore = { headers: { 'Cache-Control': 'no-store' } };

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitize(raw: unknown): DocxHighlight[] {
  if (!Array.isArray(raw)) return [];
  const out: DocxHighlight[] = [];
  for (const item of raw.slice(0, MAX_HIGHLIGHTS)) {
    if (typeof item !== 'object' || item === null) continue;
    const h = item as Record<string, unknown>;
    const start = Number(h.start);
    const end = Number(h.end);
    if (typeof h.id !== 'string' || !h.id || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
    const note = text(h.note, 5000);
    out.push({
      id: h.id.slice(0, 80),
      type: h.type === 'unknown' ? 'unknown' : 'important',
      text: text(h.text, 5000),
      ...(note ? { note } : {}),
      start,
      end,
      prefix: text(h.prefix, 80),
      suffix: text(h.suffix, 80),
      createdAt: text(h.createdAt, 40) || new Date().toISOString(),
    });
  }
  return out;
}

function sidecar(req: NextRequest): { relativePath: string; file: string } | NextResponse {
  const relativePath = req.nextUrl.searchParams.get('path')?.trim();
  if (!relativePath || !isDocxPath(relativePath)) {
    return NextResponse.json({ error: 'path must point to a .docx file' }, { status: 400 });
  }
  return { relativePath, file: docxSidecarPath(resolveFolderPath(relativePath), 'highlights.json') };
}

// GET ?path=<file.docx> -> { highlights }
export async function GET(req: NextRequest) {
  const target = sidecar(req);
  if (target instanceof NextResponse) return target;
  try {
    const raw = JSON.parse(await fs.readFile(target.file, 'utf8'));
    return NextResponse.json({ highlights: sanitize(raw) }, noStore);
  } catch {
    return NextResponse.json({ highlights: [] }, noStore);
  }
}

// PUT ?path=<file.docx> body { highlights } -> replaces the whole list
export async function PUT(req: NextRequest) {
  const target = sidecar(req);
  if (target instanceof NextResponse) return target;
  try {
    const body = await req.json() as { highlights?: unknown };
    const highlights = sanitize(body?.highlights);
    await fs.mkdir(path.dirname(target.file), { recursive: true });
    await fs.writeFile(target.file, JSON.stringify(highlights, null, 2));
    return NextResponse.json({ highlights }, noStore);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save highlights';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
