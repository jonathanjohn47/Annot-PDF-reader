// How the model asks for a PDF edit (a hidden JSON block, same idea as the note directive), and when an edit is allowed at all.

export const EDIT_START = '<<<ANNOT_EDIT_START>>>';
export const EDIT_END = '<<<ANNOT_EDIT_END>>>';

const EDIT_BLOCK_REGEX = /<<<ANNOT_EDIT_START>>>([\s\S]*?)<<<ANNOT_EDIT_END>>>/g;

export interface ExtractEditDirectiveResult {
  cleanedContent: string;
  found: boolean;
  parsed?: unknown;
  parseError?: string;
  blockCount: number;
}

function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : text).trim();
}

// Pulls the hidden edit proposal out of a reply. Only the first block is used; the visible prose is kept.
export function extractEditDirective(content: string): ExtractEditDirectiveResult {
  const matches = [...content.matchAll(EDIT_BLOCK_REGEX)];
  const cleanedContent = content.replace(EDIT_BLOCK_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();

  if (matches.length === 0) {
    // A start marker without an end marker means the reply was cut off; never apply half a proposal.
    const truncated = content.includes(EDIT_START);
    return {
      cleanedContent: truncated ? content.slice(0, content.indexOf(EDIT_START)).trim() : content,
      found: truncated,
      parseError: truncated ? 'The edit proposal was cut off before its end marker.' : undefined,
      blockCount: 0,
    };
  }

  try {
    return { cleanedContent, found: true, parsed: JSON.parse(stripFence(matches[0][1])), blockCount: matches.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { cleanedContent, found: true, parseError: `The edit proposal is not valid JSON (${reason}).`, blockCount: matches.length };
  }
}

export interface EditIntentResult {
  explicit: boolean;
  reason: string;
}

const EDIT_VERB = /\b(edit|modify|improve|annotate|add|insert|put|place|include|append|draw|create|embed|incorporate|remove|delete|cut|drop|rewrite|rephrase|revise|reword|replace|change|update|fix|correct|move|reorder|reorganis[ez]e|restructure|merge)\b/i;
const IN_DOCUMENT = /\b(?:in|into|to|on|onto|inside|within|from|of)\s+(?:the|this|my|that)?\s*(?:pdf|document|doc|paper|page|file)\b/i;
const EDIT_THE_DOCUMENT = /\b(?:edit|modify|update|change|improve|annotate)\s+(?:the|this|my)\s+(?:pdf|document|paper)\b/i;
const REMOVE_TARGET = /\b(?:remove|delete|cut|drop)\s+(?:this|the|that|these|those)\s+(?:\w+\s+){0,2}(?:paragraph|passage|sentence|section|page|figure|caption|diagram)\b/i;
const QUESTION_START = /^\s*(?:what|why|how|when|where|which|who|whom|whose|is|are|does|do|did|can i|could i|should i|will|would|explain|tell me|define|describe|summari[sz]e)\b/i;
const POLITE_REQUEST = /\b(?:can you|could you|would you|will you|please|i want you to|i'd like you to|i would like you to|go ahead and)\b/i;
const HOW_TO = /\bhow (?:do|can|could|would|should|to)\b/i;

// An edit is only allowed when the user asks for a persistent change, or has switched edit mode on in the UI.
export function detectEditIntent(prompt: string): EditIntentResult {
  const text = prompt.trim();
  if (!text) return { explicit: false, reason: 'empty prompt' };
  if (!EDIT_VERB.test(text)) return { explicit: false, reason: 'no editing verb' };

  const polite = POLITE_REQUEST.test(text);
  if (HOW_TO.test(text) && !polite) return { explicit: false, reason: 'asks how to edit, not to edit' };
  if (QUESTION_START.test(text) && !polite && !/\b(?:and|then|also)\s+(?:add|insert|put|include)\b/i.test(text)) {
    return { explicit: false, reason: 'a question, not a request to change the document' };
  }

  if (EDIT_THE_DOCUMENT.test(text)) return { explicit: true, reason: 'asks to edit the document' };
  if (IN_DOCUMENT.test(text)) return { explicit: true, reason: 'asks for a change inside the document' };
  if (REMOVE_TARGET.test(text)) return { explicit: true, reason: 'asks to remove a specific passage' };
  return { explicit: false, reason: 'no explicit target in the document' };
}
