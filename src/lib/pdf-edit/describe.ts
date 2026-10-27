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
    case 'image': return 'your attached image';
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
    case 'delete_section':
      return `Remove everything from ${quoteShort(op.from.start_quote)}${op.from.end_quote ? ` to ${quoteShort(op.from.end_quote)}` : ''} (a figure, diagram or block) on page ${op.from.page}.`;
    case 'clean_file':
      return 'Clean up the file: remove hidden duplicate copies that earlier edits left inside pages (nothing visible changes; the pages open faster).';
    case 'renumber_pages':
      return 'Renumber the printed page numbers so every page shows its own position.';
    case 'pull_up':
      return `Move the content that starts the next page up into the empty space at the bottom of page ${op.page} (the next page is removed if nothing else is left on it).`;
    case 'move_section':
      return `Move the section starting ${quoteShort(op.from.start_quote)} (page ${op.from.page}) ${describePlacement(op.to)}.`;
  }
}

export function isDestructiveOp(op: EditOp): boolean {
  return op.type !== 'insert_content';
}
