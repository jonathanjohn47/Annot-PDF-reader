import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateProposal } from '../../src/lib/pdf-edit/schema.ts';

const base = (ops: unknown[], extra: Record<string, unknown> = {}) => ({
  intent: 'insert_text',
  summary: 's',
  rationale: 'r',
  placement_rationale: 'p',
  ops,
  ...extra,
});
const insert = (blocks: unknown[], placement: unknown = { page: 2, before_quote: 'some words here' }) => ({ type: 'insert_content', placement, blocks });

describe('validateProposal', () => {
  it('accepts a minimal valid proposal and fills defaults', () => {
    const result = validateProposal(base([insert([{ type: 'paragraph', text: 'Hello' }])]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.proposal.facts, []);
      assert.deepEqual(result.proposal.terms_defined, []);
    }
  });

  it('rejects unknown operations (no arbitrary writes)', () => {
    const result = validateProposal(base([{ type: 'overwrite_file', path: '/etc/passwd' }]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /unknown operation/);
  });

  it('drops unknown fields instead of passing them through', () => {
    const result = validateProposal(base([{ ...insert([{ type: 'paragraph', text: 'x', evil: 1 }]), shell: 'rm -rf /' }]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(JSON.stringify(result.proposal).includes('rm -rf'), false);
      assert.equal(JSON.stringify(result.proposal).includes('evil'), false);
    }
  });

  it('requires an explicit location', () => {
    const result = validateProposal(base([insert([{ type: 'paragraph', text: 'x' }], { page: 2 })]));
    assert.equal(result.ok, false);
  });

  it('rejects two anchors at once', () => {
    const result = validateProposal(base([insert([{ type: 'paragraph', text: 'x' }], { page: 2, after_quote: 'aaa bbb', position: 'page_end' })]));
    assert.equal(result.ok, false);
  });

  it('rejects diagram edges to nodes that do not exist', () => {
    const spec = { kind: 'flow', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zzz' }] };
    const result = validateProposal(base([insert([{ type: 'diagram', caption: 'c', spec }])]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /unknown node 'zzz'/);
  });

  it('bounds the size of what a proposal may contain', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: 'x' }));
    const result = validateProposal(base([insert([{ type: 'diagram', caption: 'c', spec: { kind: 'flow', nodes: many } }])]));
    assert.equal(result.ok, false);
    const longText = validateProposal(base([insert([{ type: 'paragraph', text: 'x'.repeat(5000) }])]));
    assert.equal(longText.ok, false);
  });

  it('requires evidence for in_document claims and for document prerequisites', () => {
    const result = validateProposal(base([insert([{ type: 'paragraph', text: 'x' }])], {
      claims: [{ text: 'c', status: 'in_document' }],
      prerequisites: [{ term: 't', status: 'defined_in_document' }],
    }));
    assert.equal(result.ok, false);
  });

  it('treats a prerequisite defined by the edit as a term the edit introduces', () => {
    const result = validateProposal(base([insert([{ type: 'paragraph', text: 'x' }])], {
      prerequisites: [{ term: 'logit', status: 'defined_by_this_edit' }],
    }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.proposal.terms_defined, ['logit']);
  });

  it('validates every operation kind', () => {
    const result = validateProposal(base([
      { type: 'replace_passage', page: 3, quote: 'old words here', replacement: 'new words' },
      { type: 'delete_passage', page: 3, quote: 'redundant paragraph start' },
      { type: 'delete_pages', pages: [4] },
      { type: 'move_pages', pages: [5], after_page: 1 },
      { type: 'move_section', from: { page: 2, start_quote: 'start words' }, to: { page: 3, position: 'page_end' } },
    ]));
    assert.equal(result.ok, true, result.ok ? '' : result.errors.join('\n'));
  });
});
