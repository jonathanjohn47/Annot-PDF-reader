// Helpers shared by the read-aloud player: what one spoken piece looks like, how plain paragraphs
// are cut into pieces a voice can generate quickly, and which voice reads them.

export type SpeechItem = { text: string; page?: number };

const MAX_SEGMENT_CHARS = 900;
const MIN_SEGMENT_CHARS = 160;

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_SEGMENT_CHARS) return [paragraph];

  const sentences = paragraph.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) ?? [paragraph];
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_SEGMENT_CHARS) {
      parts.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Long paragraphs are split at sentence ends; tiny ones are joined with their neighbour so the
// voice is not restarted for every short line.
export function chunkParagraphs(paragraphs: string[]): string[] {
  const segments: string[] = [];
  for (const paragraph of paragraphs.flatMap(splitLongParagraph)) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.length < MIN_SEGMENT_CHARS && last.length + paragraph.length <= MAX_SEGMENT_CHARS) {
      segments[segments.length - 1] = `${last}\n${paragraph}`;
    } else {
      segments.push(paragraph);
    }
  }
  return segments;
}

export function pickVoice(text: string): string {
  return /[ऀ-ॿ]/.test(text) ? 'hi-IN-SwaraNeural' : 'en-IN-NeerjaNeural';
}
