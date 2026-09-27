import OpenAI from 'openai'
import { ProviderError } from './openaiGateway.ts'

export interface EmbeddingResult { model: string; dimension: number; vectors: number[][]; usage?: { inputTokens: number }; providerRequestId?: string }

export function createOpenAIEmbeddingGateway(apiKey: string, model: string, dimension: number, client: OpenAI = new OpenAI({ apiKey, maxRetries: 0, timeout: 15000 })) {
  return async (texts: string[], signal: AbortSignal): Promise<EmbeddingResult> => {
    try {
      const response = await client.embeddings.create({ model, input: texts, dimensions: dimension, encoding_format: 'float' }, { signal, timeout: 15000, maxRetries: 0 })
      const ordered = [...response.data].sort((a, b) => a.index - b.index)
      if (ordered.length !== texts.length || ordered.some((item, index) => item.index !== index || item.embedding.length !== dimension || item.embedding.some(value => !Number.isFinite(value)))) throw new ProviderError('server_error', 502)
      return { model: response.model, dimension, vectors: ordered.map(item => item.embedding),
        usage: response.usage ? { inputTokens: response.usage.prompt_tokens } : undefined,
        providerRequestId: response._request_id ?? undefined }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (signal.aborted) throw new ProviderError('timeout', 504)
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
      if (status === 401 || status === 403) throw new ProviderError('authentication', 503)
      if (status === 429) throw new ProviderError('rate_limited', 429)
      if (status === 408 || error instanceof OpenAI.APIConnectionTimeoutError) throw new ProviderError('timeout', 504)
      throw new ProviderError('server_error', 502)
    }
  }
}
