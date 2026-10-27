import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { documentKindOf, isDocumentFileName, isDocxPath, isPdfPath, stripDocumentExtension } from '../../src/lib/document-types.ts';

describe('document types', () => {
  it('tells PDF and Word files apart, ignoring case and folders', () => {
    assert.equal(documentKindOf('Papers/Report.PDF'), 'pdf');
    assert.equal(documentKindOf('notes/Plan v2.DocX'), 'docx');
    assert.equal(documentKindOf('notes/plan.doc'), null);
    assert.equal(documentKindOf('notes/plan.docx.bak'), null);
    assert.equal(documentKindOf(null), null);
    assert.ok(isPdfPath('a.pdf') && !isPdfPath('a.docx'));
    assert.ok(isDocxPath('a.docx') && !isDocxPath('a.pdf'));
    assert.ok(isDocumentFileName('a.docx') && isDocumentFileName('a.pdf') && !isDocumentFileName('a.txt'));
  });

  it('strips only the document extension', () => {
    assert.equal(stripDocumentExtension('Higher MI.pdf'), 'Higher MI');
    assert.equal(stripDocumentExtension('Thesis.draft.DOCX'), 'Thesis.draft');
    assert.equal(stripDocumentExtension('notes.txt'), 'notes.txt');
  });
});
