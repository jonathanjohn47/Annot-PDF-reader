import path from 'path';

import { getWorkspaceRoot, resolveFolderPath } from '@/lib/annot-sessions';
import { isDocxPath } from '@/lib/document-types';
import { ensureDocxMarkdown } from '@/lib/docx-convert';

/**
 * What the AI needs to read a document it cannot open itself. A PDF it can read directly; a Word file is given as a
 * Markdown copy (kept next to it in .annot/docx). Returns the copy's path relative to the workspace root.
 */
export async function documentTextPathFor(documentPath: string | null | undefined): Promise<string | null> {
  if (!documentPath || !isDocxPath(documentPath)) return null;
  const markdownAbs = await ensureDocxMarkdown(resolveFolderPath(documentPath));
  return path.relative(getWorkspaceRoot(), markdownAbs).split(path.sep).join('/');
}

export function cleanLocation(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 900) : null;
}
