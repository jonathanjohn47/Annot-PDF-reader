import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { pickVoice } from '@/lib/speech-text';

export const runtime = 'nodejs';

const MAX_TEXT_CHARS = 2000;
const SYNTHESIS_TIMEOUT_MS = 30_000;

// Edge TTS is an unofficial Microsoft endpoint that changes its auth token now and then. The python
// `edge-tts` package tracks those changes fastest, so we run its CLI instead of a JS port.
// Setup: python3 -m venv .tts-venv && .tts-venv/bin/pip install edge-tts
// Override the binary with EDGE_TTS_BIN if it lives somewhere else.
function resolveEdgeTtsBin(): string {
  if (process.env.EDGE_TTS_BIN) return process.env.EDGE_TTS_BIN;
  const localBin = path.join(process.cwd(), '.tts-venv', 'bin', 'edge-tts');
  return existsSync(localBin) ? localBin : 'edge-tts';
}

function runEdgeTts(text: string, voice: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // "--text=" form so a text starting with "-" is not mistaken for a flag; no shell is involved.
    execFile(
      resolveEdgeTtsBin(),
      ['--voice', voice, `--text=${text}`, '--write-media', outputFile],
      { timeout: SYNTHESIS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        reject(
          new Error(
            missing
              ? 'edge-tts is not installed. Run: python3 -m venv .tts-venv && .tts-venv/bin/pip install edge-tts'
              : stderr.trim().split('\n').pop() || error.message,
          ),
        );
      },
    );
  });
}

// POST /api/tts — Turn a short piece of plain text into an mp3 using Edge TTS
export async function POST(req: NextRequest) {
  let workDir: string | null = null;
  try {
    const body = (await req.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return NextResponse.json({ error: `text is longer than ${MAX_TEXT_CHARS} characters` }, { status: 413 });
    }

    workDir = await mkdtemp(path.join(tmpdir(), 'annot-tts-'));
    const outputFile = path.join(workDir, 'speech.mp3');
    await runEdgeTts(text, pickVoice(text), outputFile);

    return new NextResponse(await readFile(outputFile), {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate speech';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}
