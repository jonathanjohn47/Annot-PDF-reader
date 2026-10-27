import { SessionKind, AIProvider } from '@/types';
import type { EditPromptContext } from '@/lib/pdf-edit/edit-prompt';

export interface ProviderModel {
  id: string;
  owned_by: string;
  created: number;
  display_name?: string;
}

export interface ProviderStatus {
  provider: AIProvider;
  authenticated: boolean;
  email?: string;
  planType?: string;
  authMethod?: string;
  expiresAt?: number;
  hasRefreshToken?: boolean;
}

export interface ProviderValidationResult {
  provider: AIProvider;
  ok: boolean;
  model?: string;
  response?: string;
  message: string;
}

export interface ProviderTurnEvent {
  type: 'status' | 'assistant_delta' | 'tool_use' | 'tool_result';
  message?: string;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  exitCode?: number | null;
}

export interface ProviderTurnInput {
  providerSessionId?: string;
  model: string;
  /** Reasoning effort for providers that support it (Claude). Absent means the provider default. */
  effort?: 'low' | 'medium' | 'high';
  folderPath: string;
  sessionKind: SessionKind;
  prompt: string;
  currentPdfPath?: string | null;
  selectedText?: string | null;
  /** Page (1-based) the user is viewing in the PDF viewer, when known. */
  currentPage?: number | null;
  /** For a Word document: Markdown copy the AI reads (workspace-relative), and what is at the top of the screen. */
  documentTextPath?: string | null;
  currentLocation?: string | null;
  screenshotPaths?: string[];
  /** Files and images the user attached from disk to this message (workspace-relative paths). */
  attachmentPaths?: string[];
  /** PDF-editing instructions for this turn (see lib/pdf-edit). Absent means editing is not offered. */
  edit?: EditPromptContext;
}

export interface ProviderTurnResult {
  providerSessionId: string;
  content: string;
}

export interface ProviderRuntime {
  id: AIProvider;
  listModels: () => Promise<ProviderModel[]>;
  getStatus: () => Promise<ProviderStatus>;
  validateConnection: () => Promise<ProviderValidationResult>;
  runTurn: (
    input: ProviderTurnInput,
    options?: { onEvent?: (event: ProviderTurnEvent) => void }
  ) => Promise<ProviderTurnResult>;
}
