import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskLifeLineService } from './askService'
import { mockAskProvider } from './askProvider'
import { archive, db } from './db'
import { mockEmbeddingProvider } from './embeddingProvider'
import { SemanticSearchService } from './semanticIndex'
import { seed } from './seed'

beforeEach(async () => {
  db.close(); await db.delete(); await db.open()
  await db.entries.bulkPut(seed.entries); await db.people.bulkPut(seed.people); await db.places.bulkPut(seed.places); await db.tags.bulkPut(seed.tags); await db.eras.bulkPut(seed.eras)
})
afterAll(() => db.close())

describe('Ask retrieval before synthesis', () => {
  it('falls back to structured/keyword retrieval without semantic opt-in and never answers during retrieval', async () => {
    const answer = vi.fn(mockAskProvider.answer)
    const service = new AskLifeLineService({ kind: 'local', answer }, new SemanticSearchService(mockEmbeddingProvider))
    const data = await archive(); const before = JSON.stringify(data)
    const found = await service.retrieve(data, "What do I remember about Grandma's house?", {}, new AbortController().signal)
    expect(found.semanticUsed).toBe(false)
    expect(found.evidence.map(item => item.memoryId)).toEqual(['m-pokemon'])
    expect(answer).not.toHaveBeenCalled()
    expect(await service.answer('Grandma?', found.evidence, new AbortController().signal)).toMatchObject({ sourceMemoryIds: ['m-pokemon'] })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await archive())).toBe(before)
  })

  it('uses the existing semantic index and re-retrieves for a follow-up', async () => {
    const semantic = new SemanticSearchService(mockEmbeddingProvider)
    await semantic.setEnabled(true)
    await semantic.indexPending(await archive(), await mockEmbeddingProvider.info(), new AbortController().signal)
    const spy = vi.spyOn(mockEmbeddingProvider, 'embedQuery')
    const service = new AskLifeLineService(mockAskProvider, semantic)
    const first = await service.retrieve(await archive(), 'What happened when I moved to Phoenix?', {}, new AbortController().signal)
    expect(first.semanticUsed).toBe(true)
    const second = await service.retrieve(await archive(), 'What happened then?', {}, new AbortController().signal, 'What happened when I moved to Phoenix?')
    expect(second.semanticUsed).toBe(true)
    expect(second.evidence.some(item => item.memoryId === 'm-move')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('retains retrieved sources when the answer provider is unavailable', async () => {
    const service = new AskLifeLineService({ kind: 'remote', answer: async () => { throw Error('unavailable') } }, undefined)
    const found = await service.retrieve(await archive(), 'What happened in 2010?', {}, new AbortController().signal)
    expect(found.evidence.map(item => item.memoryId)).toEqual(['m-move'])
    await expect(service.answer('What happened in 2010?', found.evidence, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(found.evidence).toHaveLength(1)
  })
})
