import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractGotoDirective } from '../../src/lib/goto-directive.ts';

describe('extractGotoDirective', () => {
  it('pulls out the page and keeps the prose', () => {
    const result = extractGotoDirective('Grok epoch is defined on page 14.\n<<<ANNOT_GOTO page=14>>>');
    assert.equal(result.page, 14);
    assert.equal(result.cleanedContent, 'Grok epoch is defined on page 14.');
  });

  it('tolerates spacing inside the block', () => {
    assert.equal(extractGotoDirective('Here.\n<<<ANNOT_GOTO  page = 7 >>>').page, 7);
  });

  it('takes the last block and removes all of them', () => {
    const result = extractGotoDirective('<<<ANNOT_GOTO page=3>>>\nText.\n<<<ANNOT_GOTO page=9>>>');
    assert.equal(result.page, 9);
    assert.equal(result.cleanedContent, 'Text.');
  });

  it('rejects page 0', () => {
    const result = extractGotoDirective('Text.\n<<<ANNOT_GOTO page=0>>>');
    assert.equal(result.page, null);
    assert.equal(result.cleanedContent, 'Text.');
  });

  it('returns plain replies untouched', () => {
    const result = extractGotoDirective('It means the score before softmax.');
    assert.equal(result.page, null);
    assert.equal(result.cleanedContent, 'It means the score before softmax.');
  });
});
