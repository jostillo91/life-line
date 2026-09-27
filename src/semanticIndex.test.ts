import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archive, db } from './db'
import { mockEmbeddingProvider } from './embeddingProvider'
import { SemanticSearchService } from './semanticIndex'
import { seed } from './seed'

async function reset() {
  db.close(); await db.delete(); await db.open()
  await db.entries.bulkPut(seed.entries)
  await db.people.bulkPut(seed.people)
  await db.places.bulkPut(seed.places)
  await db.tags.bulkPut(seed.tags)
  await db.eras.bulkPut(seed.eras)
}

describe('local derived semantic index', () => {
  beforeEach(reset)
  afterAll(() => db.close())

  it('indexes bounded batches, skips unchanged memories, and reindexes only changed text', async () => {
    const spy = vi.spyOn(mockEmbeddingProvider, 'embedDocuments')
    const service = new SemanticSearchService(mockEmbeddingProvider)
    const info = await mockEmbeddingProvider.info()
    expect(await service.isEnabled()).toBe(false)
    await service.setEnabled(true)
    expect((await service.plan(await archive(), info)).status.pending).toBe(seed.entries.length)
    expect(await service.indexPending(await archive(), info, new AbortController().signal)).toEqual({ indexed: seed.entries.length, failures: 0 })
    expect(spy).toHaveBeenCalledTimes(Math.ceil(seed.entries.length / 2))
    expect((await service.plan(await archive(), info)).status).toMatchObject({ indexed: seed.entries.length, pending: 0 })
    await service.indexPending(await archive(), info, new AbortController().signal)
    expect(spy).toHaveBeenCalledTimes(Math.ceil(seed.entries.length / 2))
    await db.entries.put({ ...seed.entries[0], body: 'Changed story' })
    expect((await service.plan(await archive(), info)).status.pending).toBe(1)
    await service.indexPending(await archive(), info, new AbortController().signal)
    expect(spy).toHaveBeenCalledTimes(Math.ceil(seed.entries.length / 2) + 1)
    spy.mockRestore()
  })

  it('marks only Memories linked to a renamed Person stale, and removes deleted Memory vectors', async () => {
    const service = new SemanticSearchService(mockEmbeddingProvider)
    const info = await mockEmbeddingProvider.info()
    await service.setEnabled(true)
    await service.indexPending(await archive(), info, new AbortController().signal)
    await db.people.put({ ...seed.people[0], name: 'Father' })
    const changed = await service.plan(await archive(), info)
    expect(changed.pending.map(item => item.document.memoryId).sort()).toEqual(seed.entries.filter(entry => entry.peopleIds.includes(seed.people[0].id)).map(entry => entry.id).sort())
    await db.entries.delete(seed.entries[0].id)
    await service.deleteMemory(seed.entries[0].id)
    expect(await db.semanticVectors.get(seed.entries[0].id)).toBeUndefined()
  })

  it('requires rebuild for a different model/version and clears only derived vectors', async () => {
    const service = new SemanticSearchService(mockEmbeddingProvider)
    const info = await mockEmbeddingProvider.info()
    await service.setEnabled(true)
    await service.indexPending(await archive(), info, new AbortController().signal)
    expect((await service.plan(await archive(), { ...info, model: 'another-model' })).status).toMatchObject({ pending: seed.entries.length, requiresRebuild: true })
    const before = await archive()
    await service.clearIndex()
    expect(await db.semanticVectors.count()).toBe(0)
    expect(await archive()).toEqual(before)
    expect(await service.isEnabled()).toBe(true)
  })

  it('keeps canonical Memories unchanged when an embedding batch fails and allows retry', async () => {
    const failing = { ...mockEmbeddingProvider, embedDocuments: vi.fn(async () => { throw Error('temporary') }) }
    const service = new SemanticSearchService(failing)
    const before = await archive()
    const result = await service.indexPending(before, await failing.info(), new AbortController().signal)
    expect(result.failures).toBe(seed.entries.length)
    expect(await archive()).toEqual(before)
    expect(await db.semanticVectors.count()).toBe(0)
    expect((await new SemanticSearchService(mockEmbeddingProvider).plan(await archive(), await mockEmbeddingProvider.info())).status.pending).toBe(seed.entries.length)
  })
})

describe('Dexie migration', () => {
  it('adds the derived vector table to an existing version-5 archive without changing canonical records', async () => {
    db.close(); await db.delete()
    const legacy = new Dexie('life-line-diary')
    legacy.version(5).stores({ entries: 'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people: 'id,name', places: 'id,name', tags: 'id,name', eras: 'id,name', media: 'id,mediaType,filename,importedAt,contentHash,captureDate,placeId', mediaFiles: 'key', restoreFiles: 'key' })
    await legacy.open()
    await legacy.table('entries').put(seed.entries[0])
    legacy.close()
    await db.open()
    expect((await db.entries.get(seed.entries[0].id))?.title).toBe(seed.entries[0].title)
    expect(await db.semanticVectors.count()).toBe(0)
    db.close()
  })
})
