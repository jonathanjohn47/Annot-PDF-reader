export interface ExtractGotoDirectiveResult {
  cleanedContent: string;
  /** 1-based page of the file the model wants the viewer to scroll to, or null when it asked for none. */
  page: number | null;
}

const GOTO_BLOCK_PATTERN = '<<<ANNOT_GOTO\\s+page\\s*=\\s*(\\d{1,6})\\s*>>>';

// Pulls the model's hidden "take the reader to this page" directive out of its reply.
// See lib/prompt-context.ts for the instruction that produces this block.
// The last block wins if the model emits several; every block is removed from the visible text.
export function extractGotoDirective(content: string): ExtractGotoDirectiveResult {
  const matches = [...content.matchAll(new RegExp(GOTO_BLOCK_PATTERN, 'g'))];
  if (matches.length === 0) return { cleanedContent: content, page: null };

  const page = Number(matches[matches.length - 1][1]);
  const cleanedContent = content.replace(new RegExp(GOTO_BLOCK_PATTERN, 'g'), '').trim();
  return { cleanedContent, page: page >= 1 ? page : null };
}
