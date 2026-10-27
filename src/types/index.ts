// ── Tree Structure ──────────────────────────────────────────────

// 'pdf' and 'docx' are both openable documents (see lib/document-types.ts).
export type TreeNodeType = 'folder' | 'pdf' | 'docx';

export interface TreeNode {
  id: string;
  name: string;
  type: TreeNodeType;
  path: string;            // filesystem path relative to root
  children?: TreeNode[];   // only for folders
}

// ── Sessions ────────────────────────────────────────────────────

// A 'pdf' session is a session about one document; it is a Word file when pdfPath ends in .docx (kept for stored sessions).
export type SessionKind = 'folder' | 'pdf';
export type AIProvider = 'codex' | 'claude' | 'ollama';

export interface Session {
  id: string;
  folderPath: string;      // which folder this session belongs to
  sessionKind: SessionKind;
  pdfPath?: string;
  provider: AIProvider;
  providerSessionId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  turnSummaries?: SessionTurnSummary[];
  model?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: string;
  /** Id of the PDF edit proposal this reply produced (see lib/pdf-edit). */
  proposalId?: string;
}

export interface SessionTurnSummary {
  id: string;
  questionMessageId: string;
  assistantMessageId: string;
  question: string;
  answerSummary: string;
  createdAt: string;
  model?: string;
}

// ── Highlights ──────────────────────────────────────────────────

export interface Highlight {
  id: string;
  annotationId?: string;
  pdfPath: string;
  page: number;
  type: 'important' | 'unknown';
  text: string;
  note?: string;
  rects?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// ── Notes ───────────────────────────────────────────────────────

export interface PdfNote {
  id: string;
  pdfPath: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

// ── Word highlights ─────────────────────────────────────────────

/** A highlight in a Word document, anchored by text (character offsets plus quoted context), not by page position. */
export interface DocxHighlight {
  id: string;
  type: 'important' | 'unknown';
  text: string;
  note?: string;
  /** Character offsets in the document's readable text (see lib/docx-annotations.ts). */
  start: number;
  end: number;
  /** Text just before and after, used to find the passage again if the offsets no longer match. */
  prefix: string;
  suffix: string;
  createdAt: string;
}
