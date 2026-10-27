// Word (.docx) support: a document is turned into HTML for the viewer and into Markdown for the AI by pandoc.
// Both are cached next to the document in `.annot/docx/` and rebuilt when the .docx is newer.
// No alias imports here, so the node test runner can load this file directly.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { buildExecutableCandidates, finalizeResolvedCommand, resolveExecutable, type ResolvedCommand } from './command-runtime.ts';

const PANDOC_TIMEOUT_MS = 60_000;
const MAX_DOCX_BYTES = 80 * 1024 * 1024;

let resolvedPandoc: Promise<ResolvedCommand> | null = null;

export class PandocMissingError extends Error {
  constructor() {
    super('Opening Word files needs pandoc, which was not found. Install it (for example `brew install pandoc`) or set PANDOC_BIN, then reopen the file.');
  }
}

async function resolvePandoc(): Promise<ResolvedCommand> {
  if (!resolvedPandoc) {
    const home = os.homedir();
    const candidates = buildExecutableCandidates([process.env.PANDOC_BIN], 'pandoc', [
      '/opt/homebrew/bin/pandoc',
      '/usr/local/bin/pandoc',
      '/usr/bin/pandoc',
      path.join(home, '.local', 'bin', 'pandoc'),
      path.join(process.env.LOCALAPPDATA || '', 'Pandoc', 'pandoc'),
    ]);
    resolvedPandoc = resolveExecutable(candidates).then(async (found) => {
      if (!found) throw new PandocMissingError();
      return finalizeResolvedCommand(found);
    });
    resolvedPandoc.catch(() => { resolvedPandoc = null; });
  }
  return resolvedPandoc;
}

async function runPandoc(args: string[]): Promise<string> {
  const pandoc = await resolvePandoc();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(pandoc.command, [...pandoc.argsPrefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Converting the Word file took too long and was stopped.'));
    }, PANDOC_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Could not read this Word file: ${stderr.trim().split('\n').slice(-2).join(' ') || `pandoc exited with ${code}`}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

// --sandbox: the document cannot make pandoc read local files or fetch URLs. Images inside the .docx are embedded.
const COMMON_ARGS = ['-f', 'docx', '--wrap=none', '--track-changes=accept', '--sandbox'];

export interface DocxHtml {
  html: string;
  title: string;
}

export async function convertDocxToHtml(docxAbs: string): Promise<DocxHtml> {
  const standalone = await runPandoc([
    ...COMMON_ARGS, '-t', 'html5', '--mathml', '--embed-resources', '--standalone', '--metadata', 'pagetitle=document', docxAbs,
  ]);
  const start = standalone.indexOf('<body>');
  const end = standalone.lastIndexOf('</body>');
  const html = start >= 0 && end > start ? standalone.slice(start + '<body>'.length, end).trim() : standalone;
  const title = /<h1 class="title">([\s\S]*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
  return { html, title };
}

export async function convertDocxToMarkdown(docxAbs: string): Promise<string> {
  return runPandoc([...COMMON_ARGS, '-t', 'gfm-tex_math_gfm+tex_math_dollars-raw_html', docxAbs]);
}

function cacheDir(docxAbs: string): string {
  return path.join(path.dirname(docxAbs), '.annot', 'docx');
}

export function docxSidecarPath(docxAbs: string, suffix: 'html.json' | 'md' | 'highlights.json'): string {
  return path.join(cacheDir(docxAbs), `${path.basename(docxAbs)}.${suffix}`);
}

async function isFresh(cacheFile: string, sourceMtimeMs: number): Promise<boolean> {
  try {
    return (await fs.stat(cacheFile)).mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

async function statDocx(docxAbs: string): Promise<number> {
  const stat = await fs.stat(docxAbs);
  if (!stat.isFile()) throw new Error('File not found');
  if (stat.size > MAX_DOCX_BYTES) throw new Error('This Word file is too large to open.');
  return stat.mtimeMs;
}

export async function getDocxHtml(docxAbs: string): Promise<DocxHtml> {
  const mtime = await statDocx(docxAbs);
  const cacheFile = docxSidecarPath(docxAbs, 'html.json');
  if (await isFresh(cacheFile, mtime)) {
    try {
      return JSON.parse(await fs.readFile(cacheFile, 'utf8')) as DocxHtml;
    } catch {
      // unreadable cache: rebuild below
    }
  }
  const converted = await convertDocxToHtml(docxAbs);
  await fs.mkdir(cacheDir(docxAbs), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(converted));
  return converted;
}

/** Absolute path of a Markdown copy of the document, for the AI to read. */
export async function ensureDocxMarkdown(docxAbs: string): Promise<string> {
  const mtime = await statDocx(docxAbs);
  const cacheFile = docxSidecarPath(docxAbs, 'md');
  if (!(await isFresh(cacheFile, mtime))) {
    const markdown = await convertDocxToMarkdown(docxAbs);
    await fs.mkdir(cacheDir(docxAbs), { recursive: true });
    await fs.writeFile(cacheFile, markdown);
  }
  return cacheFile;
}

const SIDECAR_SUFFIXES = ['html.json', 'md', 'highlights.json'] as const;

function backupsDirOf(docxAbs: string): string {
  return path.join(path.dirname(docxAbs), '.annot', 'docx', 'backups');
}

async function backupNames(docxAbs: string): Promise<string[]> {
  try {
    return (await fs.readdir(backupsDirOf(docxAbs))).filter((name) => name.startsWith(`${path.basename(docxAbs)}.`) && name.endsWith('.bak'));
  } catch {
    return [];
  }
}

/** Highlights, caches and saved-over versions live next to the document, so they must follow it when it is renamed or moved. */
export async function moveDocxSidecars(fromAbs: string, toAbs: string): Promise<void> {
  for (const suffix of SIDECAR_SUFFIXES) {
    const from = docxSidecarPath(fromAbs, suffix);
    try {
      await fs.access(from);
    } catch {
      continue;
    }
    const to = docxSidecarPath(toAbs, suffix);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }
  for (const name of await backupNames(fromAbs)) {
    const to = path.join(backupsDirOf(toAbs), `${path.basename(toAbs)}${name.slice(path.basename(fromAbs).length)}`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(path.join(backupsDirOf(fromAbs), name), to);
  }
}

export async function removeDocxSidecars(docxAbs: string): Promise<void> {
  for (const suffix of SIDECAR_SUFFIXES) {
    await fs.rm(docxSidecarPath(docxAbs, suffix), { force: true });
  }
  for (const name of await backupNames(docxAbs)) {
    await fs.rm(path.join(backupsDirOf(docxAbs), name), { force: true });
  }
}
