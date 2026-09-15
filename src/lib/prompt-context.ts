import { getWorkspaceRoot } from '@/lib/annot-sessions';
import { SessionKind } from '@/types';

export interface AnnotPromptInput {
  folderPath: string;
  sessionKind: SessionKind;
  prompt: string;
  currentPdfPath?: string | null;
  selectedText?: string | null;
  screenshotPath?: string | null;
}

export function buildAnnotPrompt(input: AnnotPromptInput, screenshotInstruction: string): string {
  const {
    folderPath,
    sessionKind,
    prompt,
    currentPdfPath,
    selectedText,
    screenshotPath,
  } = input;

  const workspaceRoot = getWorkspaceRoot();
  const contextLines = [
    'Annot session context:',
    `- Workspace root: ${workspaceRoot}`,
    `- Current session folder: ${folderPath || '.'}`,
    `- Session type: ${sessionKind === 'pdf' ? 'PDF-focused reading session' : 'Folder-wide research session'}`,
    currentPdfPath ? `- Current PDF open in the viewer: ${currentPdfPath}` : '- No PDF is currently open in the viewer.',
    ...(selectedText?.trim()
      ? [
          '- The user has selected the following text in the PDF viewer. Treat it as the primary focus of their request unless the request clearly says otherwise:',
          '"""',
          selectedText.trim(),
          '"""',
        ]
      : []),
    ...(screenshotPath?.trim()
      ? [
          `- The user captured a screenshot region from the PDF viewer (likely a math equation, diagram, or figure) at this path: ${screenshotPath.trim()}`,
          `- ${screenshotInstruction}`,
        ]
      : []),
    sessionKind === 'pdf'
      ? '- Treat the current PDF as the primary document for this conversation. Only branch out when it materially helps.'
      : '- Prefer the current folder first, but you may inspect other files in the workspace if needed.',
    '- When writing math, wrap standalone equations in \\[ ... \\] (or $$ ... $$). Do not emit bare equation lines.',
    '- Wrap inline math in \\( ... \\) or $ ... $. Do not leave LaTeX commands bare inside prose.',
    '- Keep inline variables or short expressions inline, for example `x`, `M_t`, or `alpha_t`.',
    '- Use tools and shell commands silently when needed.',
    '- In your final answer to the user, do not include progress updates, tool narration, or chain-of-thought.',
    '- The final answer should contain only the user-facing result.',
    '',
    'Explanation style (always follow this, for every reply):',
    '- Write entirely in English. Explain the way a warm, patient Indian teacher would to a student back home — an Indian tone and accent coming through in the phrasing, everyday Indian idioms and turns of phrase, and analogies drawn from familiar Indian life (cricket, chai, trains, market haggling, festivals, joint families, exams, etc.) wherever they genuinely help the idea land.',
    '- Follow an NCERT textbook style: plain, simple language; introduce and define each new term before using it; build up step by step from basics to the point; use short, concrete examples rather than abstract ones.',
    '- Do not mix in Hindi or any other language — keep every word in English, technical terms, code, and formulas precise, while the tone, idiom, and framing stay distinctly Indian.',
    '- Stay accurate and precise; the friendly tone and Indian framing should make the explanation easier to relate to, never dumb it down or replace correctness.',
    '',
    'User request:',
    prompt,
  ];

  return contextLines.join('\n');
}
