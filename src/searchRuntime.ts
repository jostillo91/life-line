import { createRemoteEmbeddingProvider, mockEmbeddingProvider } from './embeddingProvider'
import { SemanticSearchService } from './semanticIndex'

export const aiEndpoint = import.meta.env.VITE_LIFE_LINE_AI_ENDPOINT || '/api/memory-assistant'
export const embeddingProvider = import.meta.env.VITE_LIFE_LINE_AI_MODE === 'openai'
  ? createRemoteEmbeddingProvider(aiEndpoint)
  : import.meta.env.VITE_LIFE_LINE_AI_MODE === 'mock' || (import.meta.env.DEV && !import.meta.env.VITE_LIFE_LINE_AI_MODE)
    ? mockEmbeddingProvider : undefined
export const semanticService = embeddingProvider ? new SemanticSearchService(embeddingProvider) : undefined
