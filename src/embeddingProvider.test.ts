import { describe, expect, it, vi } from 'vitest'
import { createRemoteEmbeddingProvider } from './embeddingProvider'

describe('remote embedding provider', () => {
  it('uses the authenticated narrow endpoint and receives server-selected model metadata', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/status')
      ? new Response(JSON.stringify({ embedding: { status: 'ready', model: 'text-embedding-3-small', dimension: 2 } }))
      : new Response(JSON.stringify({ model: 'text-embedding-3-small', dimension: 2, vectors: [[1, 0]] })))
    const provider = createRemoteEmbeddingProvider('/api/memory-assistant/', fetcher as typeof fetch)
    expect(await provider.info()).toEqual({ model: 'text-embedding-3-small', dimension: 2 })
    expect(await provider.embedQuery('family trip', new AbortController().signal)).toMatchObject({ vectors: [[1, 0]] })
    expect(fetcher.mock.calls[1][0]).toBe('/api/memory-assistant/embed')
    const request = fetcher.mock.calls[1][1] as RequestInit
    expect(request.credentials).toBe('include')
    expect(request.cache).toBe('no-store')
    expect(JSON.parse(String(request.body))).toEqual({ kind: 'query', texts: ['family trip'] })
  })

  it('rejects unauthenticated, rate-limited and malformed responses without archive mutation', async () => {
    const signal = new AbortController().signal
    for (const [status, message] of [[401, 'Sign in'], [429, 'rate limited']] as const) {
      const provider = createRemoteEmbeddingProvider('/api/memory-assistant', vi.fn(async () => new Response('', { status })) as typeof fetch)
      await expect(provider.embedDocuments(['Title: A'], signal)).rejects.toThrow(message)
    }
    const malformed = createRemoteEmbeddingProvider('/api/memory-assistant', vi.fn(async () => new Response(JSON.stringify({ model: 'x', dimension: 2, vectors: [[Number.NaN, 1]] }))) as typeof fetch)
    await expect(malformed.embedDocuments(['Title: A'], signal)).rejects.toThrow('unusable result')
  })
})
