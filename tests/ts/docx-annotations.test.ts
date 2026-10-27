import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDocxHighlightsMarkdown, resolveAnchor, selectionParagraphs } from '../../src/lib/docx-annotations.ts';
import type { DocxHighlight } from '../../src/types/index.ts';

const TEXT = 'Intro line.\nThe model weights are saved every 100 epochs.\nThe model weights are saved every 100 epochs.\nEnd.';

function highlight(over: Partial<DocxHighlight>): DocxHighlight {
  return { id: 'h', type: 'important', text: 'saved every 100 epochs', start: 0, end: 0, prefix: '', suffix: '', createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

describe('highlight anchors', () => {
  it('keeps the saved offsets while the text still matches there', () => {
    const start = TEXT.indexOf('saved every');
    const spot = resolveAnchor(TEXT, highlight({ start, end: start + 22 }));
    assert.deepEqual(spot, { start, end: start + 22 });
  });

  it('finds the passage again when text was added before it', () => {
    const edited = `A new opening paragraph.\n${TEXT}`;
    const start = TEXT.indexOf('saved every');
    const spot = resolveAnchor(edited, highlight({ start, end: start + 22, prefix: 'The model weights are ', suffix: '.\nThe model' }));
    assert.equal(edited.slice(spot!.start, spot!.end), 'saved every 100 epochs');
    assert.equal(spot!.start, edited.indexOf('saved every'));
  });

  it('picks the repeated passage whose surroundings match', () => {
    const second = TEXT.lastIndexOf('saved every');
    const edited = `Shifted. ${TEXT}`;
    const spot = resolveAnchor(edited, highlight({ start: second, end: second + 22, prefix: 'weights are ', suffix: '.\nEnd.' }));
    assert.equal(spot!.start, edited.lastIndexOf('saved every'));
  });

  it('gives up when the passage is gone', () => {
    assert.equal(resolveAnchor('Nothing alike here.', highlight({ start: 3, end: 25 })), null);
  });
});

describe('highlight export', () => {
  it('lists yellow and red highlights in reading order with their memos', () => {
    const markdown = buildDocxHighlightsMarkdown('Papers/My Report.docx', [
      highlight({ id: 'b', type: 'unknown', text: 'second one', start: 50, end: 60, note: 'ask about this' }),
      highlight({ id: 'a', type: 'important', text: '> first one', start: 5, end: 16 }),
    ], new Date('2026-02-03T04:05:06.000Z'));
    assert.match(markdown, /^# My Report Highlights/);
    assert.match(markdown, /Source document: `Papers\/My Report.docx`/);
    assert.match(markdown, /## Yellow Highlights\n\n### 1\n\n> \\> first one/);
    assert.match(markdown, /## Red Highlights\n\n### 1\n\n> second one\n\nMemo: ask about this/);
  });

  it('says so when a colour has no highlights', () => {
    assert.match(buildDocxHighlightsMarkdown('a.docx', []), /## Yellow Highlights\n\nNone\./);
  });
});

describe('read aloud', () => {
  it('splits a selection into paragraphs and drops equation placeholders and empty lines', () => {
    assert.deepEqual(selectionParagraphs('First  line here.\n\n￼\nSecond   line.\n  \n'), ['First line here.', 'Second line.']);
  });
});
