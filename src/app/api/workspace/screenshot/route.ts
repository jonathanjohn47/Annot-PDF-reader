import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { resolveFolderPath } from '@/lib/annot-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pdfPath, imageDataUrl } = body as {
      pdfPath?: string;
      imageDataUrl?: string;
    };

    if (!pdfPath?.trim()) {
      return NextResponse.json({ error: 'pdfPath is required' }, { status: 400 });
    }

    if (!imageDataUrl?.startsWith(PNG_DATA_URL_PREFIX)) {
      return NextResponse.json({ error: 'imageDataUrl must be a PNG data URL' }, { status: 400 });
    }

    const trimmedPdfPath = pdfPath.trim();
    const lastSlash = trimmedPdfPath.lastIndexOf('/');
    const folderPath = lastSlash === -1 ? '' : trimmedPdfPath.slice(0, lastSlash);

    const absoluteFolder = resolveFolderPath(folderPath);
    const screenshotsDir = path.join(absoluteFolder, '.annot', 'screenshots');
    await fs.mkdir(screenshotsDir, { recursive: true });

    const fileName = `${randomUUID()}.png`;
    const buffer = Buffer.from(imageDataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64');
    await fs.writeFile(path.join(screenshotsDir, fileName), buffer);

    const relativePath = folderPath
      ? `${folderPath}/.annot/screenshots/${fileName}`
      : `.annot/screenshots/${fileName}`;

    return NextResponse.json({ path: relativePath }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save screenshot';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
