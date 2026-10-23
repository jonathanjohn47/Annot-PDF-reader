import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildEditPromptLines } from '../../src/lib/pdf-edit/edit-prompt.ts';

describe('edit prompt', () => {
  it('forbids edits and the protocol when editing is not allowed (chat-only questions)', () => {
    const text = buildEditPromptLines({ allowed: false }).join('\n');
    assert.match(text, /editing is OFF/i);
    assert.doesNotMatch(text, /ANNOT_EDIT_START/);
  });

  it('carries the decision process, the integrity rules and the typed vocabulary when allowed', () => {
    const text = buildEditPromptLines({
      allowed: true,
      pdfAbsPath: '/tmp/a.pdf',
      scriptPath: '/app/pdf-engine/annot_pdf_edit.py',
      pythonCommand: 'python3',
      documentMap: 'Pages: 8',
    }).join('\n');
    for (const needle of [
      'Step 1 - Intent', 'Step 2 - Inspect', 'Step 3 - Diagnose', 'Step 4 - Design', 'Step 5 - Self-check', 'Step 6 - Emit',
      'never modify the PDF file directly', 'ANNOT_EDIT_START', 'insert_content', 'replace_passage', 'move_pages',
      'facts [', 'source of truth', 'chat-only', 'at most one edit block', 'annot_pdf_edit.py', 'Pages: 8',
    ]) {
      assert.ok(text.includes(needle), `missing: ${needle}`);
    }
  });

  it('is turned off when no PDF is open', () => {
    assert.match(buildEditPromptLines({ allowed: true, pdfAbsPath: null }).join('\n'), /editing is OFF/i);
  });
});
