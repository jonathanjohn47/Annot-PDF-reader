import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectEditIntent, extractEditDirective } from '../../src/lib/pdf-edit/directive.ts';

const block = (json: string) => `Here is my proposal.\n<<<ANNOT_EDIT_START>>>\n${json}\n<<<ANNOT_EDIT_END>>>`;

describe('extractEditDirective', () => {
  it('pulls out the JSON and keeps the prose', () => {
    const result = extractEditDirective(block('{"a":1}'));
    assert.equal(result.found, true);
    assert.deepEqual(result.parsed, { a: 1 });
    assert.equal(result.cleanedContent, 'Here is my proposal.');
  });

  it('accepts a fenced json block', () => {
    const result = extractEditDirective(block('```json\n{"a":2}\n```'));
    assert.deepEqual(result.parsed, { a: 2 });
  });

  it('reports invalid JSON instead of guessing', () => {
    const result = extractEditDirective(block('{"a":'));
    assert.equal(result.found, true);
    assert.equal(result.parsed, undefined);
    assert.match(result.parseError ?? '', /not valid JSON/);
  });

  it('never accepts a block that was cut off', () => {
    const result = extractEditDirective('Proposal.\n<<<ANNOT_EDIT_START>>>\n{"a":1');
    assert.equal(result.found, true);
    assert.equal(result.parsed, undefined);
    assert.match(result.parseError ?? '', /cut off/);
    assert.equal(result.cleanedContent, 'Proposal.');
  });

  it('returns plain replies untouched', () => {
    const result = extractEditDirective('It means the score before softmax.');
    assert.equal(result.found, false);
    assert.equal(result.cleanedContent, 'It means the score before softmax.');
  });

  it('uses only the first block when several are present', () => {
    const result = extractEditDirective(`${block('{"n":1}')}\n${block('{"n":2}')}`);
    assert.deepEqual(result.parsed, { n: 1 });
    assert.equal(result.blockCount, 2);
  });
});

describe('detectEditIntent (chat-only unless the user asks for a change)', () => {
  const explicit = [
    'Add a diagram of the experiment to the PDF',
    'Can you insert an explanation of logits into the document before this paragraph?',
    'please put a short definition of logit on page 3 of the pdf',
    'Remove this redundant paragraph from the document',
    'delete the repeated paragraph',
    'Rewrite this passage in the paper so it defines logit first',
    'Edit the PDF so the terms come before their use',
    'Explain this and then add a diagram into the PDF',
  ];
  const chatOnly = [
    'What does this mean?',
    'Why is the background score averaged?',
    'Explain logits to me',
    'How do I add a diagram to the PDF?',
    'Is it a good idea to remove this paragraph?',
    'Summarise page 4',
    'Add this to my notes',
    'Calculate the entropy for these values',
    'make this clearer',
  ];

  for (const prompt of explicit) {
    it(`edit: ${prompt}`, () => assert.equal(detectEditIntent(prompt).explicit, true, detectEditIntent(prompt).reason));
  }
  for (const prompt of chatOnly) {
    it(`chat: ${prompt}`, () => assert.equal(detectEditIntent(prompt).explicit, false, detectEditIntent(prompt).reason));
  }
});
