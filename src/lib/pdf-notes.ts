import { promises as fs } from 'fs';
import path from 'path';

import { resolveFolderPath } from '@/lib/annot-sessions';
import { PdfNote } from '@/types';

function sanitizePdfPath(pdfPath: string): string {
  const normalized = path.normalize(pdfPath || '.');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Invalid PDF path: ${pdfPath}`);
  }
  return normalized;
}

function getNotesFile(pdfPath: string): string {
  const normalized = sanitizePdfPath(pdfPath);
  const dir = path.dirname(normalized);
  const folderPath = dir === '.' ? '' : dir;
  return path.join(resolveFolderPath(folderPath), '.annot', 'notes.json');
}

async function ensureNotesFile(pdfPath: string): Promise<string> {
  const notesFile = getNotesFile(pdfPath);
  await fs.mkdir(path.dirname(notesFile), { recursive: true });

  try {
    await fs.access(notesFile);
  } catch {
    await fs.writeFile(notesFile, '[]');
  }

  return notesFile;
}

async function readAllNotes(pdfPath: string): Promise<PdfNote[]> {
  const notesFile = await ensureNotesFile(pdfPath);
  const raw = await fs.readFile(notesFile, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as PdfNote[] : [];
  } catch {
    return [];
  }
}

async function writeAllNotes(pdfPath: string, notes: PdfNote[]): Promise<void> {
  const notesFile = await ensureNotesFile(pdfPath);
  await fs.writeFile(notesFile, JSON.stringify(notes, null, 2));
}

export async function listPdfNotes(pdfPath: string): Promise<PdfNote[]> {
  const normalized = sanitizePdfPath(pdfPath);
  const notes = await readAllNotes(pdfPath);

  return notes
    .filter((note) => note.pdfPath === normalized)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function createPdfNote(pdfPath: string, title: string, content: string): Promise<PdfNote> {
  const normalized = sanitizePdfPath(pdfPath);
  const notes = await readAllNotes(pdfPath);
  const now = new Date().toISOString();

  const note: PdfNote = {
    id: crypto.randomUUID(),
    pdfPath: normalized,
    title: title.trim() || 'Untitled note',
    content,
    createdAt: now,
    updatedAt: now,
  };

  notes.push(note);
  await writeAllNotes(pdfPath, notes);
  return note;
}

export async function updatePdfNote(
  pdfPath: string,
  noteId: string,
  updates: { title?: string; content?: string },
): Promise<PdfNote> {
  const notes = await readAllNotes(pdfPath);
  const index = notes.findIndex((note) => note.id === noteId);

  if (index === -1) {
    throw new Error(`Note not found: ${noteId}`);
  }

  const next: PdfNote = {
    ...notes[index],
    ...(updates.title !== undefined ? { title: updates.title.trim() || 'Untitled note' } : {}),
    ...(updates.content !== undefined ? { content: updates.content } : {}),
    updatedAt: new Date().toISOString(),
  };

  notes[index] = next;
  await writeAllNotes(pdfPath, notes);
  return next;
}

export async function deletePdfNote(pdfPath: string, noteId: string): Promise<void> {
  const notes = await readAllNotes(pdfPath);
  const next = notes.filter((note) => note.id !== noteId);

  if (next.length !== notes.length) {
    await writeAllNotes(pdfPath, next);
  }
}
