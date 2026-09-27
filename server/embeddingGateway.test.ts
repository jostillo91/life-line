import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantAPI, RequestLimiter } from './assistantApi'
import { createOpenAIEmbeddingGateway } from './embeddingGateway'
import { PrivateAccess } from './privateAccess'

const base = 'http://localhost/api/memory-assistant'
const origin = 'https://diary.example'
const access = new PrivateAccess('a sufficiently long test-only password')
const cookie = access.signIn('a sufficiently long test-only password')!.cookie.split(';')[0]
const body = { kind: 'documents', texts: ['Title: School\nStory: A classroom', 'Title: Trip\nStory: A journey'] }
const request = (value: unknown, authenticated = true, requestOrigin = origin) => new Request(`${base}/embed`, {
  method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) }, body: JSON.stringify(value),
})
const embedding = { model: 'text-embedding-3-small', dimension: 2, vectors: [[1, 0], [0, 1]], usage: { inputTokens: 12 } }

describe('authenticated embedding endpoint', () => {
  it('rejects unauthenticated and wrong-origin calls before invoking the provider', async () => {
    const embed = vi.fn(async () => embedding)
    const api = createAssistantAPI({ allowedOrigin: origin, access, embed, embeddingInfo: { model: embedding.model, dimension: 2 } })
    expect((await api(request(body, false), 'client')).status).toBe(401)
    expect((await api(request(body, true, 'https://other.example'), 'client')).status).toBe(403)
    expect(embed).not.toHaveBeenCalled()
  })

  it('accepts bounded known requests and records usage without logging archive text', async () => {
    const embed = vi.fn(async () => embedding)
    const log = vi.fn()
    const api = createAssistantAPI({ allowedOrigin: origin, access, embed, embeddingInfo: { model: embedding.model, dimension: 2 }, log })
    const response = await api(request(body), 'client')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.json()).toMatchObject({ model: embedding.model, dimension: 2, vectors: embedding.vectors, metadata: { usage: embedding.usage } })
    expect(embed).toHaveBeenCalledWith(body.texts, expect.any(AbortSignal))
    expect(JSON.stringify(log.mock.calls)).not.toContain('classroom')
    const diagnostic = await api(new Request(`${base}/diagnostics`, { headers: { Cookie: cookie } }), 'client')
    expect(await diagnostic.json()).toMatchObject({ embeddingRequests: 1, embeddingInputTokens: 12 })
    const status = await api(new Request(`${base}/status`, { headers: { Cookie: cookie } }), 'client')
    expect(await status.json()).toMatchObject({ embedding: { status: 'ready', model: embedding.model, dimension: 2 } })
  })

  it('rejects unknown modes, extra fields, empty queries, oversized batches and bodies', async () => {
    const embed = vi.fn(async () => embedding)
    const api = createAssistantAPI({ allowedOrigin: origin, access, embed, embeddingInfo: { model: embedding.model, dimension: 2 } })
    for (const invalid of [
      { ...body, kind: 'arbitrary' }, { ...body, extra: 'x' }, { kind: 'query', texts: [''] },
      { kind: 'query', texts: ['one', 'two'] }, { kind: 'documents', texts: ['a', 'b', 'c'] },
      { kind: 'documents', texts: ['a'.repeat(3501)] },
    ]) expect((await api(request(invalid), 'client')).status).toBe(400)
    const freshApi = createAssistantAPI({ allowedOrigin: origin, access, embed, embeddingInfo: { model: embedding.model, dimension: 2 } })
    expect((await freshApi(request({ kind: 'documents', texts: ['a'.repeat(11_000)] }), 'client')).status).toBe(413)
    expect(embed).not.toHaveBeenCalled()
  })

  it('shares the per-session and global emergency limiter with assistant calls', async () => {
    const embed = vi.fn(async () => ({ ...embedding, vectors: [[1, 0]] }))
    const api = createAssistantAPI({ allowedOrigin: origin, access, embed, embeddingInfo: { model: embedding.model, dimension: 2 }, limiter: new RequestLimiter(1, 1, 1) })
    expect((await api(request({ kind: 'query', texts: ['school'] }), 'client')).status).toBe(200)
    expect((await api(request({ kind: 'query', texts: ['school'] }), 'client')).status).toBe(429)
    expect(embed).toHaveBeenCalledTimes(1)
  })
})

describe('OpenAI embedding gateway', () => {
  it('uses server-selected model/dimensions and validates ordered vectors', async () => {
    const create = vi.fn(async (_params: unknown) => ({ model: 'text-embedding-3-small', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 }, _request_id: 'req-test' }))
    const gateway = createOpenAIEmbeddingGateway('server-test-key', 'text-embedding-3-small', 2, { embeddings: { create } } as unknown as OpenAI)
    expect(await gateway(['first', 'second'], new AbortController().signal)).toMatchObject({ vectors: [[1, 0], [0, 1]], usage: { inputTokens: 7 } })
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'text-embedding-3-small', input: ['first', 'second'], dimensions: 2, encoding_format: 'float' })
  })

  it('rejects malformed vectors without returning archive data', async () => {
    const gateway = createOpenAIEmbeddingGateway('server-test-key', 'text-embedding-3-small', 2,
      { embeddings: { create: async () => ({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: [Number.NaN, 1] }] }) } } as unknown as OpenAI)
    await expect(gateway(['first'], new AbortController().signal)).rejects.toMatchObject({ code: 'server_error' })
  })
})
