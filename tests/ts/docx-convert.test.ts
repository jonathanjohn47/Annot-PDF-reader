import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { convertDocxToHtml, convertDocxToMarkdown, ensureDocxMarkdown, getDocxHtml, moveDocxSidecars, docxSidecarPath } from '../../src/lib/docx-convert.ts';

let pandocAvailable = true;
try {
  execFileSync('pandoc', ['--version'], { stdio: 'ignore' });
} catch {
  pandocAvailable = false;
}

function makeDocx(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'annot-docx-'));
  writeFileSync(path.join(dir, 'in.md'), [
    '# Method', '', 'The grok epoch is **205** here, with $E = mc^2$ inline.', '',
    '| Seed | Epoch |', '|------|-------|', '| 0 | 12987 |', '',
    '<script>alert(1)</script>', '',
  ].join('\n'));
  const out = path.join(dir, 'Report.docx');
  execFileSync('pandoc', [path.join(dir, 'in.md'), '-o', out]);
  return out;
}

describe('docx conversion', { skip: !pandocAvailable && 'pandoc is not installed' }, () => {
  it('turns headings, tables and equations into HTML', async () => {
    const { html } = await convertDocxToHtml(makeDocx());
    assert.match(html, /<h1 id="method">Method<\/h1>/);
    assert.match(html, /<th>Seed<\/th>/);
    assert.match(html, /<math[^>]*display="inline"/);
    assert.doesNotMatch(html, /<script/i);
  });

  it('writes Markdown the AI can read, with equations as $...$', async () => {
    const markdown = await convertDocxToMarkdown(makeDocx());
    assert.match(markdown, /^# Method/m);
    assert.match(markdown, /\$E = mc\^\{2\}\$/);
    assert.match(markdown, /\| Seed \| Epoch \|/);
  });

  it('caches next to the document and rebuilds when the file is newer', async () => {
    const docx = makeDocx();
    const first = await getDocxHtml(docx);
    const cache = docxSidecarPath(docx, 'html.json');
    assert.ok(existsSync(cache));
    writeFileSync(cache, JSON.stringify({ html: '<p>cached</p>', title: '' }));
    assert.equal((await getDocxHtml(docx)).html, '<p>cached</p>');           // fresh cache is used
    const later = new Date(Date.now() + 60_000);
    utimesSync(docx, later, later);
    assert.equal((await getDocxHtml(docx)).html, first.html);                // newer docx: converted again

    const markdownPath = await ensureDocxMarkdown(docx);
    assert.match(readFileSync(markdownPath, 'utf8'), /# Method/);
  });

  it('moves highlights and caches along with a renamed file', async () => {
    const docx = makeDocx();
    await getDocxHtml(docx);
    const highlights = docxSidecarPath(docx, 'highlights.json');
    writeFileSync(highlights, '[]');
    const renamed = path.join(path.dirname(docx), 'Renamed.docx');
    mkdirSync(path.dirname(highlights), { recursive: true });
    await moveDocxSidecars(docx, renamed);
    assert.ok(existsSync(docxSidecarPath(renamed, 'highlights.json')));
    assert.ok(existsSync(docxSidecarPath(renamed, 'html.json')));
    assert.ok(!existsSync(highlights));
  });

  it('rejects a file that is not a Word document', async () => {
    const bad = path.join(mkdtempSync(path.join(tmpdir(), 'annot-docx-')), 'bad.docx');
    writeFileSync(bad, 'this is not a zip');
    await assert.rejects(() => convertDocxToHtml(bad), /Could not read this Word file/);
  });
});
