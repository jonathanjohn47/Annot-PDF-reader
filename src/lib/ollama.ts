import { buildAnnotPrompt } from '@/lib/prompt-context';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

export interface OllamaAuthStatus {
  authenticated: boolean;
  error?: string;
}

export interface OllamaModelInfo {
  id: string;
  owned_by: string;
  created: number;
  display_name?: string;
}

export interface OllamaTurnEvent {
  type: 'status' | 'assistant_delta' | 'tool_use' | 'tool_result';
  message?: string;
  text?: string;
}

interface OllamaRunTurnOptions {
  onEvent?: (event: OllamaTurnEvent) => void;
}

interface OllamaRunTurnInput {
  providerSessionId?: string;
  model: string;
  folderPath: string;
  sessionKind: 'folder' | 'pdf';
  prompt: string;
  currentPdfPath?: string | null;
  selectedText?: string | null;
  screenshotPath?: string | null;
}

interface OllamaChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Ollama has no server-side session concept, unlike the Claude/Codex CLIs
// (which persist history via --resume). Conversation history is kept here,
// in memory, keyed by a generated session id, and lost on server restart.
const conversationHistory = new Map<string, OllamaChatMessage[]>();

function buildPrompt(input: Omit<OllamaRunTurnInput, 'providerSessionId' | 'model'>): string {
  return buildAnnotPrompt(
    input,
    'Local Ollama models used here are text-only and cannot view images — tell the user you cannot see the screenshot and ask them to paste the relevant text instead.',
  );
}

export async function getOllamaAuthStatus(): Promise<OllamaAuthStatus> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      return { authenticated: false, error: `Ollama returned HTTP ${res.status}` };
    }
    return { authenticated: true };
  } catch {
    return {
      authenticated: false,
      error: `Could not reach Ollama at ${OLLAMA_HOST}. Is "ollama serve" running?`,
    };
  }
}

export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Ollama returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as { models?: Array<{ name: string; modified_at?: string }> };
  return (data.models || []).map((model) => ({
    id: model.name,
    owned_by: 'meta',
    created: model.modified_at ? Date.parse(model.modified_at) : 0,
    display_name: model.name,
  }));
}

async function chat(
  model: string,
  messages: OllamaChatMessage[],
  options: OllamaRunTurnOptions = {},
): Promise<string> {
  options.onEvent?.({ type: 'status', message: 'Thinking...' });

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `Ollama returned HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;

      const payload = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        error?: string;
      };

      if (payload.error) {
        throw new Error(payload.error);
      }

      const delta = payload.message?.content;
      if (delta) {
        content += delta;
        options.onEvent?.({ type: 'assistant_delta', text: delta });
      }
    }
  }

  return content.trim();
}

export async function runOllamaTurn(
  input: OllamaRunTurnInput,
  options: OllamaRunTurnOptions = {},
): Promise<{ providerSessionId: string; content: string }> {
  const providerSessionId = input.providerSessionId || crypto.randomUUID();
  const history = conversationHistory.get(providerSessionId) || [];

  const userMessage: OllamaChatMessage = { role: 'user', content: buildPrompt(input) };
  const messages = [...history, userMessage];

  const content = await chat(input.model, messages, options);

  conversationHistory.set(providerSessionId, [
    ...messages,
    { role: 'assistant', content },
  ]);

  return { providerSessionId, content };
}

export async function probeOllamaConnection(model: string): Promise<{ model: string; response: string }> {
  const response = await chat(model, [{ role: 'user', content: 'Reply with exactly OK.' }]);
  return { model, response };
}
