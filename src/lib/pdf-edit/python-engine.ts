import { spawn } from 'child_process';
import path from 'path';

import { getPythonCommand } from '../python-runtime.ts';
import type { EditProposal, EngineResult } from './types.ts';

const ENGINE_TIMEOUT_MS = 180_000;

export function getEngineScriptPath(): string {
  return process.env.ANNOT_EDIT_SCRIPT || path.join(process.cwd(), 'pdf-engine', 'annot_pdf_edit.py');
}

export async function runEngine<T>(payload: Record<string, unknown>): Promise<T> {
  const python = await getPythonCommand();

  return new Promise<T>((resolve, reject) => {
    const child = spawn(python.command, [...python.argsPrefix, getEngineScriptPath()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The PDF engine took too long and was stopped. Nothing was changed.'));
    }, ENGINE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `PDF engine failed with exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error('The PDF engine returned an unreadable response.'));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function buildDocumentEdit(
  pdfPath: string,
  proposal: EditProposal,
  options: { outPath?: string; previewDir?: string } = {},
): Promise<EngineResult> {
  return runEngine<EngineResult>({ action: 'build', pdfPath, proposal, ...options });
}

export interface DocumentMap {
  pageCount: number;
  text: string;
}

export function getDocumentMap(pdfPath: string, maxChars = 6000): Promise<DocumentMap> {
  return runEngine<DocumentMap>({ action: 'map', pdfPath, maxChars });
}

export function validatePdfFile(pdfPath: string): Promise<{ ok: boolean; pageCount?: number; error?: string }> {
  return runEngine({ action: 'validate_pdf', pdfPath });
}
