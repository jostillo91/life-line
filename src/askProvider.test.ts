import { describe, expect, it, vi } from 'vitest'
import { deriveAskHints, selectAskEvidence } from './askDomain'
import { createRemoteAskProvider } from './askProvider'
import { seed } from './seed'

describe('remote Ask provider', () => {
  it('sends only selected evidence and validates citations again before display', async () => {
    const evidence = selectAskEvidence(seed, '2010', deriveAskHints('2010', seed))
    const answer = { sufficiency: 'partial', claims: [{ statement: 'There is a move memory.', sourceMemoryIds: ['m-move'] }], sourceMemoryIds: ['m-move'], unresolvedQuestions: [] }
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ answer })))
    const provider = createRemoteAskProvider('/api/memory-assistant', fetcher as typeof fetch)
    expect(await provider.answer({ question: '2010?', evidence }, new AbortController().signal)).toEqual(answer)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/memory-assistant/ask')
    expect(init.credentials).toBe('include')
    const sent = JSON.parse(String(init.body))
    expect(sent.evidence.map((item: { memoryId: string }) => item.memoryId)).toEqual(['m-move'])
    expect(JSON.stringify(sent)).not.toContain(seed.entries[0].body)
    expect(JSON.stringify(sent)).not.toContain('latitude')
    expect(JSON.stringify(sent)).not.toContain('mediaIds')
    const forged = createRemoteAskProvider('/api/memory-assistant', vi.fn(async () => new Response(JSON.stringify({ answer: { ...answer, sourceMemoryIds: ['fake'] } }))) as typeof fetch)
    await expect(forged.answer({ question: '2010?', evidence }, new AbortController().signal)).rejects.toThrow('unusable')
  })
})
