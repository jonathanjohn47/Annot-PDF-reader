import { getClaudeAuthStatus, probeClaudeConnection, runClaudeTurn } from '@/lib/claude-code';
import { fetchCodexModels, getCodexAuthStatus, sendCodexChat } from '@/lib/codex-auth';
import { runCodexTurn } from '@/lib/codex-exec';
import {
  DEFAULT_OLLAMA_MODEL,
  getOllamaAuthStatus,
  listOllamaModels,
  probeOllamaConnection,
  runOllamaTurn,
} from '@/lib/ollama';
import { AIProvider } from '@/types';
import { DEFAULT_AI_PROVIDER } from './config';

import {
  ProviderModel,
  ProviderRuntime,
  ProviderTurnInput,
  ProviderTurnResult,
  ProviderTurnEvent,
} from './types';

const codexRuntime: ProviderRuntime = {
  id: 'codex',
  async listModels(): Promise<ProviderModel[]> {
    const models = await fetchCodexModels();
    if (!models) {
      throw new Error('Not authenticated. Sign in to Codex on this machine first.');
    }
    return models;
  },
  async getStatus() {
    return {
      provider: 'codex',
      ...(await getCodexAuthStatus()),
    };
  },
  async validateConnection() {
    const models = await codexRuntime.listModels();
    const model = models[0]?.id || 'gpt-5.4-mini';
    const result = await sendCodexChat(
      [{ role: 'user', content: 'Reply with exactly OK.' }],
      model,
    );

    return {
      provider: 'codex',
      ok: /^ok\b/i.test(result.content.trim()),
      model: result.model || model,
      response: result.content.trim(),
      message: 'Codex responded successfully.',
    };
  },
  async runTurn(
    input: ProviderTurnInput,
    options?: { onEvent?: (event: ProviderTurnEvent) => void },
  ): Promise<ProviderTurnResult> {
    const result = await runCodexTurn(
      {
        codexSessionId: input.providerSessionId,
        model: input.model,
        folderPath: input.folderPath,
        sessionKind: input.sessionKind,
        prompt: input.prompt,
        currentPdfPath: input.currentPdfPath,
        selectedText: input.selectedText,
        screenshotPath: input.screenshotPath,
      },
      options,
    );

    return {
      providerSessionId: result.codexSessionId,
      content: result.content,
    };
  },
};

const claudeRuntime: ProviderRuntime = {
  id: 'claude',
  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        id: 'sonnet',
        owned_by: 'anthropic',
        created: 0,
        display_name: 'Sonnet',
      },
      {
        id: 'opus',
        owned_by: 'anthropic',
        created: 0,
        display_name: 'Opus',
      },
    ];
  },
  async getStatus() {
    return {
      provider: 'claude',
      ...(await getClaudeAuthStatus()),
    };
  },
  async validateConnection() {
    const result = await probeClaudeConnection('sonnet');

    return {
      provider: 'claude',
      ok: /^ok\b/i.test(result.response.trim()),
      model: result.model,
      response: result.response,
      message: 'Claude Code responded successfully.',
    };
  },
  async runTurn(
    input: ProviderTurnInput,
    options?: { onEvent?: (event: ProviderTurnEvent) => void },
  ): Promise<ProviderTurnResult> {
    return await runClaudeTurn(input, options);
  },
};

const ollamaRuntime: ProviderRuntime = {
  id: 'ollama',
  async listModels(): Promise<ProviderModel[]> {
    const models = await listOllamaModels();
    if (models.length === 0) {
      throw new Error('No Ollama models installed. Run `ollama pull <model>` first.');
    }
    return models;
  },
  async getStatus() {
    return {
      provider: 'ollama',
      ...(await getOllamaAuthStatus()),
    };
  },
  async validateConnection() {
    const models = await ollamaRuntime.listModels();
    const model = models[0]?.id || DEFAULT_OLLAMA_MODEL;
    const result = await probeOllamaConnection(model);

    return {
      provider: 'ollama',
      ok: /^ok\b/i.test(result.response.trim()),
      model: result.model,
      response: result.response,
      message: 'Ollama responded successfully.',
    };
  },
  async runTurn(
    input: ProviderTurnInput,
    options?: { onEvent?: (event: ProviderTurnEvent) => void },
  ): Promise<ProviderTurnResult> {
    return await runOllamaTurn(
      {
        providerSessionId: input.providerSessionId,
        model: input.model || DEFAULT_OLLAMA_MODEL,
        folderPath: input.folderPath,
        sessionKind: input.sessionKind,
        prompt: input.prompt,
        currentPdfPath: input.currentPdfPath,
        selectedText: input.selectedText,
        screenshotPath: input.screenshotPath,
      },
      options,
    );
  },
};

const providerRegistry: Record<AIProvider, ProviderRuntime> = {
  codex: codexRuntime,
  claude: claudeRuntime,
  ollama: ollamaRuntime,
};

export function getProviderRuntime(provider: AIProvider = DEFAULT_AI_PROVIDER): ProviderRuntime {
  const runtime = providerRegistry[provider];
  if (!runtime) {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  return runtime;
}
