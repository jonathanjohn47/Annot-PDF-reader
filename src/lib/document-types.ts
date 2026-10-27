// Which files Annot can open. A "document" is a PDF or a Word (.docx) file; both are listed in the tree, get chat
// sessions and notes, and are keyed by their workspace-relative path.

export type DocumentKind = 'pdf' | 'docx';

export function documentKindOf(filePath: string | null | undefined): DocumentKind | null {
  const lower = (filePath ?? '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
}

export function isPdfPath(filePath: string | null | undefined): boolean {
  return documentKindOf(filePath) === 'pdf';
}

export function isDocxPath(filePath: string | null | undefined): boolean {
  return documentKindOf(filePath) === 'docx';
}

export function isDocumentFileName(name: string): boolean {
  return documentKindOf(name) !== null;
}

export function stripDocumentExtension(name: string): string {
  return name.replace(/\.(pdf|docx)$/i, '');
}

export const DOCUMENT_ACCEPT = 'application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx';
