export interface ParsedNoteDirective {
  title: string;
  body: string;
}

export interface ExtractNoteDirectiveResult {
  cleanedContent: string;
  note: ParsedNoteDirective | null;
}

const NOTE_BLOCK_REGEX = /<<<ANNOT_NOTE_START>>>\s*TITLE:\s*(.*?)\s*\n<<<ANNOT_NOTE_BODY>>>\s*\n?([\s\S]*?)\s*<<<ANNOT_NOTE_END>>>/;

// Pulls the model's hidden "save this as a note" directive out of its reply.
// See lib/prompt-context.ts for the instruction that produces this block.
export function extractNoteDirective(content: string): ExtractNoteDirectiveResult {
  const match = content.match(NOTE_BLOCK_REGEX);

  if (!match || typeof match.index !== 'number') {
    return { cleanedContent: content, note: null };
  }

  const title = match[1].trim();
  const body = match[2].trim();
  const cleanedContent = (
    content.slice(0, match.index) + content.slice(match.index + match[0].length)
  ).trim();

  if (!title || !body) {
    return { cleanedContent, note: null };
  }

  return { cleanedContent, note: { title, body } };
}

export function appendNoteSavedConfirmation(content: string, title: string): string {
  const confirmation = `📝 Saved as a note: **"${title}"** — find it under Notes for this PDF.`;
  return content ? `${content}\n\n${confirmation}` : confirmation;
}
