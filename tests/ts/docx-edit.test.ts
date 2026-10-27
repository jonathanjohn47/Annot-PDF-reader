import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getDocxHtml, moveDocxSidecars } from '../../src/lib/docx-convert.ts';
import { backupsDir, countBackups, parseEditBlocks, saveDocxEdit, undoDocxSave } from '../../src/lib/docx-edit.ts';

let pandocAvailable = true;
try {
  execFileSync('pandoc', ['--version'], { stdio: 'ignore' });
} catch {
  pandocAvailable = false;
}

function makeDocx(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'annot-docx-edit-'));
  writeFileSync(path.join(dir, 'in.md'), '# Title\n\nFirst para here.\n\nSecond para here.\n');
  const out = path.join(dir, 'Notes.docx');
  execFileSync('pandoc', [path.join(dir, 'in.md'), '-o', out]);
  return out;
}

const plain = (file: string) => execFileSync('pandoc', ['-f', 'docx', '-t', 'plain', '--wrap=none', file], { encoding: 'utf8' });
const blocks = (second: string) => [
  { tag: 'h1', segments: [['Title', 0]] },
  { tag: 'p', segments: [['First para here.', 0]] },
  { tag: 'p', segments: [[second, 0]] },
];

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const picture = (over: Record<string, unknown> = {}) => ({ tag: 'image', image: { mime: 'image/png', data: PNG, width: 300, height: 150, ...over } });

describe('docx edit blocks', () => {
  it('accepts a pasted picture and rejects unusable ones', () => {
    assert.equal(parseEditBlocks([picture()])[0].image?.width, 300);
    assert.throws(() => parseEditBlocks([picture({ mime: 'image/webp' })]), /PNG, JPEG and GIF/);
    assert.throws(() => parseEditBlocks([picture({ data: 'not base64!' })]), /not valid/);
    assert.throws(() => parseEditBlocks([picture({ width: 0 })]), /size/);
    assert.throws(() => parseEditBlocks(Array.from({ length: 41 }, () => picture())), /At most 40/);
  });

  it('accepts well-formed blocks and rejects malformed ones', () => {
    assert.deepEqual(parseEditBlocks(blocks('x')).map((b) => b.tag), ['h1', 'p', 'p']);
    assert.throws(() => parseEditBlocks([{ tag: 'script', segments: [] }]), /malformed/);
    assert.throws(() => parseEditBlocks([{ tag: 'p', segments: [['x', 99]] }]), /malformed text run/);
    assert.throws(() => parseEditBlocks('nope'), /list/);
  });
});

describe('saving a hand edit', { skip: !pandocAvailable && 'pandoc is not installed' }, () => {
  it('changes the paragraph, keeps a backup, and can go back', async () => {
    const docx = makeDocx();
    const result = await saveDocxEdit(docx, parseEditBlocks(blocks('Second para now says more.')));
    assert.equal(result.changed, 1);
    assert.match(plain(docx), /Second para now says more\./);
    assert.match(plain(docx), /First para here\./);
    assert.equal(await countBackups(docx), 1);

    assert.equal(await undoDocxSave(docx), true);
    assert.match(plain(docx), /Second para here\./);
    assert.equal(await countBackups(docx), 0);
    assert.equal(await undoDocxSave(docx), false);
  });

  it('adds a pasted picture as a real Word picture', async () => {
    const docx = makeDocx();
    const result = await saveDocxEdit(docx, parseEditBlocks([
      { tag: 'h1', segments: [['Title', 0]] },
      { tag: 'p', segments: [['First para here.', 0]] },
      picture(),
      { tag: 'p', segments: [['Second para here.', 0]] },
    ]));
    assert.equal(result.images, 1);
    const html = execFileSync('pandoc', ['-f', 'docx', '-t', 'html5', '--embed-resources', '--standalone', '--metadata', 'pagetitle=x', docx], { encoding: 'utf8' });
    assert.match(html, /<img[^>]+src="data:image\/png;base64,/);
    assert.ok(html.indexOf('First para here.') < html.indexOf('<img') && html.indexOf('<img') < html.indexOf('Second para here.'));
    assert.equal(await undoDocxSave(docx), true);
    assert.doesNotMatch(execFileSync('pandoc', ['-f', 'docx', '-t', 'html5', '--embed-resources', '--standalone', '--metadata', 'pagetitle=x', docx], { encoding: 'utf8' }), /<img/);
  });

  it('changes nothing when nothing was edited', async () => {
    const docx = makeDocx();
    const result = await saveDocxEdit(docx, parseEditBlocks(blocks('Second para here.')));
    assert.equal(result.unchanged, true);
    assert.equal(await countBackups(docx), 0);
    assert.ok(!existsSync(`${docx}.annot-edit.tmp`));
  });

  it('refreshes what the viewer shows, and the backups follow a rename', async () => {
    const docx = makeDocx();
    assert.match((await getDocxHtml(docx)).html, /Second para here/);
    await saveDocxEdit(docx, parseEditBlocks(blocks('Second para edited.')));
    assert.match((await getDocxHtml(docx)).html, /Second para edited/);

    const renamed = path.join(path.dirname(docx), 'Renamed.docx');
    await moveDocxSidecars(docx, renamed);
    assert.deepEqual(readdirSync(backupsDir(renamed)).map((n) => n.startsWith('Renamed.docx.')), [true]);
  });

  it('reports a file that is not a Word document', async () => {
    const bad = path.join(mkdtempSync(path.join(tmpdir(), 'annot-docx-edit-')), 'bad.docx');
    writeFileSync(bad, 'not a zip');
    await assert.rejects(() => saveDocxEdit(bad, parseEditBlocks(blocks('x'))), /not a zip|Word|zip/i);
  });
});
