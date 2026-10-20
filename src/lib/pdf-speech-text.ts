import { chunkParagraphs, type SpeechItem } from './speech-text';

// Turns text selected in a PDF into pieces a voice can read. A PDF stores equations as loose
// glyphs, not LaTeX, so formulas are spotted heuristically: a line made mostly of symbols, digits
// and 1-2 letter variables is dropped, and the paragraph around it is split there.

const MIN_WORD_LETTER_SHARE = 0.55;
const MIN_KEPT_TOKEN_SHARE = 0.6;

// Math fonts store brackets, signs and radicals under ordinary-looking letters (ð þ ¼ and the long
// "ffiffiff..." radical bar), so such tokens are formula debris, not words.
const MATH_FONT_DEBRIS = /[ðþÞ¼½¾-]|ffiffi/;
const LONE_GREEK_SYMBOL = /^\(?\p{Script=Greek}+\)?[,.;:]?$/u;

function isProse(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  if (!compact || /^[\d.,()[\]-]+$/.test(compact)) return false;
  const wordLetters = (text.match(/[\p{L}\p{M}]{3,}/gu) ?? []).join('').length;
  return wordLetters / compact.length >= MIN_WORD_LETTER_SHARE;
}

function isSpeakableToken(token: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(token) || MATH_FONT_DEBRIS.test(token) || LONE_GREEK_SYMBOL.test(token)) return false;
  return !(token.length >= 8 && new Set(token).size <= 3);
}

// Returns null when most of the line was formula debris, so the caller treats it as a formula line.
function cleanLine(text: string): string | null {
  const tokens = text
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const kept = tokens.filter(isSpeakableToken);
  if (kept.length === 0 || (tokens.length >= 3 && kept.length < tokens.length * MIN_KEPT_TOKEN_SHARE)) return null;
  return kept.join(' ');
}

function extractParagraphs(selectedText: string): string[] {
  const paragraphs: string[] = [];
  let paragraph = '';

  const flush = () => {
    if (paragraph.trim()) paragraphs.push(paragraph.trim());
    paragraph = '';
  };

  for (const rawLine of selectedText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const text = line && isProse(line) ? cleanLine(line) : null;
    if (!text) {
      flush();
      continue;
    }

    if (paragraph.endsWith('-') && /^\p{Ll}/u.test(text)) {
      paragraph = paragraph.slice(0, -1) + text;
    } else {
      paragraph += (paragraph ? ' ' : '') + text;
    }
  }
  flush();

  return paragraphs;
}

// Empty when nothing in the selection is readable (for example only an equation was selected).
export function selectionSpeechItems(selectedText: string): SpeechItem[] {
  return chunkParagraphs(extractParagraphs(selectedText)).map((text) => ({ text }));
}
