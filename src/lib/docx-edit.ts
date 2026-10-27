// Hand edits to a Word file. The viewer sends the edited paragraphs; docx-engine/annot_docx_patch.py changes only the
// paragraphs that differ, so the rest of the file (fonts, colours, layout) is left exactly as it was.
// Every save keeps the previous version in .annot/docx/backups, so the last saves can be undone.
// No alias imports here, so the node test runner can load this file directly.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import { getPythonCommand } from './python-runtime.ts';

const ENGINE_TIMEOUT_MS = 60_000;
const MAX_BLOCKS = 40_000;
const MAX_TEXT_CHARS = 8_000_000;
const MAX_BACKUPS = 20;
const TAGS = new Set(['p', 'li', 'cell', 'meta', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'image']);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif']);
const MAX_IMAGE_BASE64 = 30_000_000;
const MAX_IMAGES = 40;

export interface EditBlock {
  tag: string;
  segments: Array<[string, number]>;
  /** The user worked in this block; an untouched block is compared by its text only. */
  touched: boolean;
  /** For tag 'image': a picture pasted into the page (base64, pixel size as shown). */
  image?: { mime: string; data: string; width: number; height: number };
}

export interface DocxEditResult {
  changed: number;
  inserted: number;
  deleted: number;
  warnings: string[];
  images: number;
  unchanged: boolean;
}

function parseImage(raw: unknown, index: number): NonNullable<EditBlock['image']> {
  const image = raw as { mime?: unknown; data?: unknown; width?: unknown; height?: unknown } | null;
  if (!image || typeof image.mime !== 'string' || !IMAGE_MIME.has(image.mime)) {
    throw new Error(`block ${index + 1}: only PNG, JPEG and GIF pictures can be added`);
  }
  if (typeof image.data !== 'string' || image.data.length === 0 || image.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    throw new Error(`block ${index + 1}: the picture data is not valid or is too large`);
  }
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 30_000 || height > 30_000) {
    throw new Error(`block ${index + 1}: the picture size is not valid`);
  }
  return { mime: image.mime, data: image.data, width, height };
}

export function parseEditBlocks(raw: unknown): EditBlock[] {
  if (!Array.isArray(raw)) throw new Error('blocks must be a list');
  if (raw.length > MAX_BLOCKS) throw new Error('This document is too large to save from the viewer.');
  let chars = 0;
  let images = 0;
  return raw.map((item, index) => {
    const block = item as { tag?: unknown; segments?: unknown; touched?: unknown; image?: unknown };
    const tag = typeof block?.tag === 'string' && TAGS.has(block.tag) ? block.tag : null;
    if (!tag) throw new Error(`block ${index + 1} is malformed`);
    if (tag === 'image') {
      if (++images > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} pictures can be added in one save.`);
      return { tag, segments: [], touched: true, image: parseImage(block.image, index) };
    }
    if (!Array.isArray(block.segments)) throw new Error(`block ${index + 1} is malformed`);
    const segments = block.segments.map((segment): [string, number] => {
      const [text, flags] = segment as [unknown, unknown];
      if (typeof text !== 'string' || !Number.isInteger(flags) || (flags as number) < 0 || (flags as number) > 7) {
        throw new Error(`block ${index + 1} has a malformed text run`);
      }
      chars += text.length;
      return [text, flags as number];
    });
    if (chars > MAX_TEXT_CHARS) throw new Error('This document is too large to save from the viewer.');
    return { tag, segments, touched: block.touched !== false };
  });
}

function engineScriptPath(): string {
  return process.env.ANNOT_DOCX_SCRIPT || path.join(process.cwd(), 'docx-engine', 'annot_docx_patch.py');
}

async function runPatch(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const python = await getPythonCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.argsPrefix, engineScriptPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Saving took too long and was stopped. The file was not changed.'));
    }, ENGINE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim().split('\n').slice(-2).join(' ') || `The Word editor failed (exit ${code}).`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('The Word editor returned an unreadable answer.'));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function backupsDir(docxAbs: string): string {
  return path.join(path.dirname(docxAbs), '.annot', 'docx', 'backups');
}

async function listBackups(docxAbs: string): Promise<string[]> {
  const prefix = `${path.basename(docxAbs)}.`;
  try {
    return (await fs.readdir(backupsDir(docxAbs))).filter((name) => name.startsWith(prefix) && name.endsWith('.bak')).sort();
  } catch {
    return [];
  }
}

export async function countBackups(docxAbs: string): Promise<number> {
  return (await listBackups(docxAbs)).length;
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function keepBackup(docxAbs: string): Promise<void> {
  await fs.mkdir(backupsDir(docxAbs), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  await fs.copyFile(docxAbs, path.join(backupsDir(docxAbs), `${path.basename(docxAbs)}.${stamp}.bak`));
  const all = await listBackups(docxAbs);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
    await fs.rm(path.join(backupsDir(docxAbs), old), { force: true });
  }
}

export function saveDocxEdit(docxAbs: string, blocks: EditBlock[]): Promise<DocxEditResult> {
  return serial(async () => {
    await fs.access(docxAbs);
    const staged = `${docxAbs}.annot-edit.tmp`;
    try {
      const result = await runPatch({ docxPath: docxAbs, outPath: staged, blocks });
      if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : 'Could not save the edit.');
      const unchanged = result.unchanged === true;
      if (!unchanged) {
        await keepBackup(docxAbs);
        await fs.rename(staged, docxAbs);
      }
      return {
        changed: Number(result.changed) || 0,
        inserted: Number(result.inserted) || 0,
        deleted: Number(result.deleted) || 0,
        images: Number(result.images) || 0,
        warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
        unchanged,
      };
    } finally {
      await fs.rm(staged, { force: true });
    }
  });
}

/** Puts back the version from before the latest save (the saved-over file becomes a backup too, so nothing is lost). */
export function undoDocxSave(docxAbs: string): Promise<boolean> {
  return serial(async () => {
    const all = await listBackups(docxAbs);
    const latest = all[all.length - 1];
    if (!latest) return false;
    const latestPath = path.join(backupsDir(docxAbs), latest);
    const staged = `${docxAbs}.annot-undo.tmp`;
    await fs.copyFile(latestPath, staged);
    await fs.rm(latestPath, { force: true });
    await fs.rename(staged, docxAbs);
    return true;
  });
}
