import { describe, expect, it, vi } from 'vitest'
import { buildAIContext, defaultContextSelection, MemoryAssistantService } from './assistantDomain'
import { createRemoteAIProvider } from './remoteAIProvider'
import { seed } from './seed'

const entry = seed.entries[0]
const context = buildAIContext('remember', entry, seed, defaultContextSelection())

describe('remote AI provider', () => {
  it('sends only the existing task context after consent, never the full archive', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ suggestions: [{ type: 'question', content: { text: 'Who was there?' } }], metadata: { model: 'gpt-5.6-terra', usage: { inputTokens: 10, outputTokens: 3 } } }), { status: 200 }))
    const diagnostics = vi.fn()
    const provider = createRemoteAIProvider('/api/memory-assistant', fetcher as typeof fetch, diagnostics)
    const service = new MemoryAssistantService(provider)
    await expect(service.request('remember', entry, seed, defaultContextSelection())).rejects.toThrow('consent')
    expect(fetcher).not.toHaveBeenCalled()
    const result = await service.request('remember', entry, seed, defaultContextSelection(), { remoteConsent: true })
    expect(result.suggestions).toMatchObject([{ type: 'question', status: 'pending', provider: 'life-line-server', model: 'gpt-5.6-terra' }])
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/memory-assistant')
    expect(init.credentials).toBe('include')
    const sent = JSON.parse(String(init.body))
    expect(sent).toMatchObject({ task: 'remember', context: JSON.parse(JSON.stringify(context)) })
    expect(sent).not.toHaveProperty('safetyInstructions')
    expect(JSON.stringify(sent)).not.toContain(seed.entries[4].body)
    expect(JSON.stringify(sent)).not.toContain('latitude')
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputTokens: 10, outputTokens: 3 } }))
  })

  it('maps remote errors and network failure without archive mutation', async () => {
    const before = JSON.stringify(seed)
    const rejected = createRemoteAIProvider('/api/memory-assistant', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 })) as typeof fetch)
    await expect(rejected.generate({ task: 'remember', context, safetyInstructions: '' }, new AbortController().signal)).rejects.toThrow('rate limited')
    const offline = createRemoteAIProvider('/api/memory-assistant', vi.fn(async () => { throw Error('network detail') }) as typeof fetch)
    await expect(offline.generate({ task: 'remember', context, safetyInstructions: '' }, new AbortController().signal)).rejects.toThrow('Network unavailable')
    expect(JSON.stringify(seed)).toBe(before)
  })
})
