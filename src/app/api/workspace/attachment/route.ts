import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { MAX_ATTACHMENT_BYTES } from '@/lib/screenshot-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
  return base.slice(-80) || 'file';
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const folderPath = form.get('folderPath');
    const file = form.get('file');

    if (typeof folderPath !== 'string') {
      return NextResponse.json({ error: 'folderPath is required' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `File is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)` },
        { status: 413 },
      );
    }

    const attachmentsDir = path.join(resolveFolderPath(folderPath), '.annot', 'attachments');
    await fs.mkdir(attachmentsDir, { recursive: true });

    const fileName = `${randomUUID()}-${safeFileName(file.name)}`;
    await fs.writeFile(path.join(attachmentsDir, fileName), Buffer.from(await file.arrayBuffer()));

    const relativePath = folderPath
      ? `${folderPath}/.annot/attachments/${fileName}`
      : `.annot/attachments/${fileName}`;

    return NextResponse.json({ path: relativePath, name: file.name }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save attachment';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
