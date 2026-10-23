// End-to-end through the real Python engine: preview, apply, undo/redo, restore original, discard, failure recovery.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { applyProposal, discardProposal, prepareProposal, ProposalError } from '../../src/lib/pdf-edit/pipeline.ts';
import { editsDir, getEditSummary, getProposal, redoEdit, restoreOriginal, undoEdit } from '../../src/lib/pdf-edit/store.ts';
import { runEngine } from '../../src/lib/pdf-edit/python-engine.ts';

let dir: string;
let counter = 0;

const sha = async (file: string) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function freshPdf(): Promise<string> {
  counter += 1;
  const sub = path.join(dir, `case${counter}`);
  await fs.mkdir(sub, { recursive: true });
  const file = path.join(sub, 'paper.pdf');
  execFileSync('python3', [path.resolve('tests/python/fixtures.py'), file]);
  return file;
}

const paragraphEdit = (text: string, page = 5) => ({
  intent: 'insert_text',
  summary: `Add: ${text.slice(0, 20)}`,
  rationale: 'Helps the reader.',
  placement_rationale: 'End of the page.',
  ops: [{ type: 'insert_content', placement: { page, position: 'page_end' }, blocks: [{ type: 'paragraph', text }] }],
});

const pageText = async (file: string, page: number): Promise<string> => {
  const result = await runEngine<{ pages: Array<{ blocks: Array<{ text: string }> }> }>({ action: 'text', pdfPath: file, pages: String(page) });
  return result.pages[0].blocks.map((b) => b.text).join(' ');
};

before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annot-edit-')); });
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('proposal lifecycle', () => {
  it('previews without touching the PDF, then applies, undoes, redoes and restores the original', async () => {
    const pdf = await freshPdf();
    const original = await sha(pdf);

    const proposal = await prepareProposal({ pdfPath: 'case/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('A clarifying sentence for the reader.') });
    assert.equal(proposal.status, 'pending', JSON.stringify(proposal.issues));
    assert.ok(proposal.previews.length > 0);
    assert.equal(await sha(pdf), original, 'previewing must not change the PDF');
    for (const preview of proposal.previews) {
      await fs.access(path.join(editsDir(pdf), 'proposals', proposal.id, 'previews', preview.file));
    }

    const { revision } = await applyProposal(pdf, proposal.id);
    assert.equal(revision, 1);
    assert.match(await pageText(pdf, 5), /clarifying sentence/);
    const afterFirst = await sha(pdf);
    assert.notEqual(afterFirst, original);
    assert.equal((await getProposal(pdf, proposal.id))?.status, 'applied');

    const second = await prepareProposal({ pdfPath: 'case/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('A second addition about the setup.', 3) });
    await applyProposal(pdf, second.id);
    let summary = await getEditSummary(pdf);
    assert.equal(summary.revision, 2);
    assert.equal(summary.canUndo, true);
    assert.equal(summary.entries.length, 2);

    await undoEdit(pdf);
    assert.equal(await sha(pdf), afterFirst, 'undo returns exactly the previous revision');
    summary = await getEditSummary(pdf);
    assert.equal(summary.canRedo, true);
    await redoEdit(pdf);
    assert.match(await pageText(pdf, 3), /second addition/);

    await restoreOriginal(pdf);
    assert.equal(await sha(pdf), original, 'the original is recoverable after several edits');
    await redoEdit(pdf);
    await redoEdit(pdf);
    assert.match(await pageText(pdf, 3), /second addition/, 'redo walks forward through every revision again');
    assert.match(await pageText(pdf, 5), /clarifying sentence/);
  });

  it('discarding a preview leaves the original unchanged and keeps nothing applied', async () => {
    const pdf = await freshPdf();
    const original = await sha(pdf);
    const proposal = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('Something the user will reject.') });
    const discarded = await discardProposal(pdf, proposal.id);
    assert.equal(discarded.status, 'discarded');
    assert.equal(await sha(pdf), original);
    assert.equal((await getEditSummary(pdf)).revision, 0);
    await assert.rejects(() => applyProposal(pdf, proposal.id), ProposalError);
    assert.equal(await sha(pdf), original);
  });

  it('rejects an invalid proposal with reasons and writes nothing', async () => {
    const pdf = await freshPdf();
    const original = await sha(pdf);
    const bad = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: { ...paragraphEdit('x'), ops: [{ type: 'format_disk' }] } });
    assert.equal(bad.status, 'rejected');
    assert.equal(bad.issues[0].code, 'schema');
    const unsourced = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('The model has 4096 hidden units.') });
    assert.equal(unsourced.status, 'rejected');
    assert.ok(unsourced.issues.some((i) => i.code === 'unsourced_number'));
    assert.equal(await sha(pdf), original);
  });

  it('a failing PDF operation halfway through does not corrupt or claim success', async () => {
    const pdf = await freshPdf();
    const original = await sha(pdf);
    const raw = paragraphEdit('A harmless addition.');
    raw.ops.push({ type: 'replace_passage', page: 5, quote: 'this sentence is nowhere in the document', replacement: 'x', scope: 'phrase' } as never);
    const result = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw });
    assert.equal(result.status, 'rejected');
    assert.ok(result.issues.some((i) => i.code === 'quote_not_found'));
    assert.equal(await sha(pdf), original);
    assert.equal((await getEditSummary(pdf)).revision, 0);
  });

  it('rolls back when the history cannot be recorded, so there is no untracked change', async () => {
    const pdf = await freshPdf();
    const original = await sha(pdf);
    const proposal = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('This will fail to be recorded.') });
    assert.equal(proposal.status, 'pending');
    // Make history.json unwritable by putting a non-empty directory where the file must go.
    await fs.mkdir(path.join(editsDir(pdf), 'history.json', 'blocker'), { recursive: true });
    await assert.rejects(() => applyProposal(pdf, proposal.id), /./);
    assert.equal(await sha(pdf), original, 'the live PDF was restored');
    assert.notEqual((await getProposal(pdf, proposal.id))?.status, 'applied');
  });

  it('refuses a stale apply instead of corrupting the document', async () => {
    const pdf = await freshPdf();
    const edit = {
      intent: 'revise', summary: 'Rewrite a phrase', rationale: 'r', placement_rationale: 'p', qualification_check: 'none',
      ops: [{ type: 'replace_passage', page: 5, quote: 'The background logit contributes most of the late-training change.', replacement: 'The background logit accounts for most of the late change.', scope: 'phrase' }],
    };
    const first = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: edit });
    const twin = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: edit });
    assert.equal(first.status, 'pending', JSON.stringify(first.issues));
    await applyProposal(pdf, first.id);
    const afterFirst = await sha(pdf);
    await assert.rejects(() => applyProposal(pdf, twin.id), ProposalError);   // the quoted text is gone now
    assert.equal(await sha(pdf), afterFirst);
    assert.equal((await getProposal(pdf, twin.id))?.status, 'stale');
  });

  it('a new edit after an undo discards the redo branch', async () => {
    const pdf = await freshPdf();
    const a = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('First branch text.') });
    await applyProposal(pdf, a.id);
    await undoEdit(pdf);
    const b = await prepareProposal({ pdfPath: 'c/paper.pdf', pdfAbs: pdf, raw: paragraphEdit('Second branch text.') });
    await applyProposal(pdf, b.id);
    const summary = await getEditSummary(pdf);
    assert.equal(summary.canRedo, false);
    assert.equal(summary.entries.length, 1);
    assert.match(await pageText(pdf, 5), /Second branch/);
    await restoreOriginal(pdf);
    assert.doesNotMatch(await pageText(pdf, 5), /branch/);
  });
});
