// Plain-language descriptions of operations, shown in the review card (so the user sees exactly what will change).

import type { Block, EditOp, Placement } from './types.ts';

function quoteShort(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `“${clean.slice(0, max)}…”` : `“${clean}”`;
}

function describeBlock(block: Block): string {
  switch (block.type) {
    case 'heading': return `heading “${block.text}”`;
    case 'paragraph': return 'a paragraph';
    case 'bullets': return `a ${block.items.length}-item list`;
    case 'equation': return 'an equation';
    case 'callout': return `a ${block.tone.replace('_', ' ')} box`;
    case 'table': return 'a table';
    case 'diagram': return `a ${block.spec.kind} diagram (${block.spec.nodes.length} nodes)`;
  }
}

function describePlacement(placement: Placement): string {
  if (placement.mode === 'new_pages') {
    return placement.position === 'page_start' ? `as new page(s) before page ${placement.page}` : `as new page(s) after page ${placement.page}`;
  }
  if (placement.after_quote) return `after ${quoteShort(placement.after_quote)} on page ${placement.page}`;
  if (placement.before_quote) return `before ${quoteShort(placement.before_quote)} on page ${placement.page}`;
  return placement.position === 'page_start' ? `at the top of page ${placement.page}` : `at the end of page ${placement.page}`;
}

export function describeOp(op: EditOp): string {
  switch (op.type) {
    case 'insert_content':
      return `Add ${op.blocks.map(describeBlock).join(', ')} ${describePlacement(op.placement)}.`;
    case 'replace_passage':
      return `Replace ${op.scope === 'paragraph' ? 'the paragraph containing' : ''} ${quoteShort(op.quote)} on page ${op.page}.`.replace('  ', ' ');
    case 'delete_passage':
      return `Remove ${op.scope === 'phrase' ? '' : 'the paragraph containing '}${quoteShort(op.quote)} on page ${op.page}.`;
    case 'delete_pages':
      return `Delete page${op.pages.length > 1 ? 's' : ''} ${op.pages.join(', ')}.`;
    case 'move_pages':
      return `Move page${op.pages.length > 1 ? 's' : ''} ${op.pages.join(', ')} ${op.after_page === 0 ? 'to the start' : `to after page ${op.after_page}`}.`;
    case 'move_section':
      return `Move the section starting ${quoteShort(op.from.start_quote)} (page ${op.from.page}) ${describePlacement(op.to)}.`;
  }
}

export function isDestructiveOp(op: EditOp): boolean {
  return op.type !== 'insert_content';
}
