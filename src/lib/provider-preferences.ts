import { AIProvider } from '@/types';
import { DEFAULT_AI_PROVIDER } from '@/lib/ai-providers/config';

export const AI_PROVIDER_STORAGE_KEY = 'annot-ai-provider';
export const AI_PROVIDER_EVENT = 'annot-ai-provider-change';

export function readStoredAIProvider(): AIProvider {
  // The engine is fixed in code (see DEFAULT_AI_PROVIDER); a provider saved in the browser by an older
  // version is ignored so it cannot override it.
  return DEFAULT_AI_PROVIDER;
}

export function writeStoredAIProvider(provider: AIProvider): AIProvider {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AI_PROVIDER_STORAGE_KEY, provider);
    window.dispatchEvent(new CustomEvent(AI_PROVIDER_EVENT, { detail: provider }));
  }

  return provider;
}
