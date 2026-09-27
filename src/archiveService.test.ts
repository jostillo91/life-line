import 'fake-indexeddb/auto'
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArchiveManifest } from './archiveFormat'
import { createLifeLineArchive, inspectLifeLineArchive, restoreLifeLineArchive } from './archiveService'
import { archive, db } from './db'
import { contentHashFor, readMediaFile } from './mediaStorage'
import { decryptLifeLineArchive, encryptLifeLineArchive, inspectBackupContainer } from './encryptedArchive'
import type { Archive, Entry, Media } from './types'

const bytes = new Uint8Array([0, 1, 2, 3, 254, 255])

function memory(mediaId = 'media-1'): Entry {
  return {
    id: 'memory-1', title: 'Archived memory', body: 'Preserved story', entryType: 'memory',
    eventDate: { precision: 'season', start: '2014-01-01', season: 'Summer', confidence: 'likely' },
    recordTime: '2026-09-22T00:00:00Z', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
    importance: 3, status: 'active', peopleIds: ['person-1'], placeIds: ['place-1'], tagIds: ['tag-1'],
    mediaIds: [mediaId], relatedEntryIds: [],
  }
}

async function fixture(mediaId = 'media-1'): Promise<{ data: Archive; media: Media }> {
  const hash = await contentHashFor(new Blob([bytes]))
  const media: Media = {
    id: mediaId, mediaType: 'image', filename: 'original.jpg', mimeType: 'image/jpeg', byteSize: bytes.length,
    importedAt: '2026-09-22T00:00:00Z', contentHash: hash, captureDate: '2014-07-01',
    captureDateSource: 'exif-original', captureDateConfidence: 'high', captureDatePrecision: 'exact',
    photoMetadata: { latitude: 33.4484, longitude: -112.074, cameraMake: 'Canon', cameraModel: 'EOS' },
    placeId: 'place-1', storageKey: `media/${mediaId}`, version: 3,
  }
  return {
    media,
    data: {
      entries: [memory(mediaId)],
      people: [{ id: 'person-1', name: 'Alice' }],
      places: [{ id: 'place-1', name: 'Home', latitude: 33.4484, longitude: -112.074 }],
      tags: [{ id: 'tag-1', name: 'Family', color: '#ffffff' }],
      eras: [{ id: 'era-1', name: 'School Years', start: '2010-01-01', end: '2018-01-01' }],
      media: [media],
    },
  }
}

async function seed(value: Awaited<ReturnType<typeof fixture>>) {
  await db.entries.bulkPut(value.data.entries)
  await db.people.bulkPut(value.data.people)
  await db.places.bulkPut(value.data.places)
  await db.tags.bulkPut(value.data.tags)
  await db.eras.bulkPut(value.data.eras)
  await db.media.bulkPut(value.data.media ?? [])
  await db.mediaFiles.put({ key: value.media.storageKey, blob: new Blob([bytes], { type: value.media.mimeType }) })
}

async function resetDatabase() {
  db.close()
  await db.delete()
  await db.open()
}

describe('full archive backup and restore', () => {
  beforeEach(resetDatabase)
  afterAll(() => db.close())

  it('creates a self-contained ZIP with manifest, structured data, and original bytes', async () => {
    await seed(await fixture())
    await db.semanticVectors.put({ memoryId: 'memory-1', sourceType: 'memory', model: 'test', dimension: 1, indexVersion: 1, fingerprint: 'derived', generatedAt: '', vector: [1] })
    const created = await createLifeLineArchive()
    const reader = new ZipReader(new BlobReader(created.blob), { useWebWorkers: false })
    const entries = await reader.getEntries()
    const names = entries.map(entry => entry.filename)
    const mediaEntry = entries.find(entry => entry.filename === created.manifest.mediaFiles[0].path)

    expect(created.filename).toBe(`Life-Line-Backup-${created.manifest.exportedAt.slice(0, 10)}.zip`)
    expect(names).toContain('manifest.json')
    expect(names).toContain('data.json')
    expect(names.some(name => name.includes('semantic'))).toBe(false)
    expect(mediaEntry && !mediaEntry.directory ? new Uint8Array(await mediaEntry.arrayBuffer()) : undefined).toEqual(bytes)
    await reader.close()
  })

  it('roundtrips memories, entities, dates, relationships, metadata, and binary bytes through Replace', async () => {
    const original = await fixture()
    await seed(original)
    const created = await createLifeLineArchive()
    const inspected = await inspectLifeLineArchive(created.blob)
    await resetDatabase()
    await db.semanticVectors.put({ memoryId: 'stale-id', sourceType: 'memory', model: 'test', dimension: 1, indexVersion: 1, fingerprint: 'stale', generatedAt: '', vector: [1] })

    await restoreLifeLineArchive(inspected, 'replace')
    expect(await db.semanticVectors.count()).toBe(0)
    const restored = await archive()
    const restoredMedia = restored.media![0]
    const restoredBlob = await readMediaFile(restoredMedia)

    expect(restored.entries[0].eventDate).toEqual(original.data.entries[0].eventDate)
    expect(restored.entries[0].mediaIds).toEqual(['media-1'])
    expect(restored.people).toEqual(original.data.people)
    expect(restored.places).toEqual(original.data.places)
    expect(restored.tags).toEqual(original.data.tags)
    expect(restored.eras).toEqual(original.data.eras)
    expect(restoredMedia).toMatchObject({ contentHash: original.media.contentHash, placeId: 'place-1', photoMetadata: { cameraModel: 'EOS' } })
    expect(new Uint8Array(await restoredBlob!.arrayBuffer())).toEqual(bytes)
  })

  it('unlocks an encrypted archive into the existing validation and Replace pipeline', async () => {
    const original = await fixture()
    await seed(original)
    const created = await createLifeLineArchive()
    const encrypted = await encryptLifeLineArchive(created.blob, 'a memorable backup phrase')
    expect((await inspectBackupContainer(encrypted)).kind).toBe('encrypted')
    const inspected = await inspectLifeLineArchive(await decryptLifeLineArchive(encrypted, 'a memorable backup phrase'))
    await resetDatabase()

    await restoreLifeLineArchive(inspected, 'replace')
    const restored = await archive()
    expect(restored.entries).toEqual(original.data.entries)
    expect(restored.media?.[0].photoMetadata).toEqual(original.media.photoMetadata)
    expect(new Uint8Array(await (await readMediaFile(restored.media![0]))!.arrayBuffer())).toEqual(bytes)
  })

  it('unlocks an encrypted archive into the existing Merge pipeline', async () => {
    await seed(await fixture('incoming-media'))
    const encrypted = await encryptLifeLineArchive((await createLifeLineArchive()).blob, 'a memorable backup phrase')
    const inspected = await inspectLifeLineArchive(await decryptLifeLineArchive(encrypted, 'a memorable backup phrase'))
    await resetDatabase()
    const local = await fixture('local-media')
    local.data.entries = [{ ...memory('local-media'), id: 'local-memory', title: 'Local memory', peopleIds: [], placeIds: [], tagIds: [] }]
    local.data.people = []
    local.data.places = []
    local.data.tags = []
    local.data.eras = []
    local.media.placeId = undefined
    await seed(local)
    await db.semanticVectors.put({ memoryId: 'local-memory', sourceType: 'memory', model: 'test', dimension: 1, indexVersion: 1, fingerprint: 'stale', generatedAt: '', vector: [1] })

    const result = await restoreLifeLineArchive(inspected, 'merge')
    expect(await db.semanticVectors.count()).toBe(0)
    expect(result.reusedMedia).toBe(1)
    expect(await db.mediaFiles.count()).toBe(1)
    expect((await archive()).entries.find(item => item.id === 'memory-1')?.mediaIds).toEqual(['local-media'])
  })

  it('rejects malformed decrypted ZIP contents through normal archive validation', async () => {
    const encrypted = await encryptLifeLineArchive(new Blob(['not a ZIP']), 'a memorable backup phrase')
    const decrypted = await decryptLifeLineArchive(encrypted, 'a memorable backup phrase')
    await expect(inspectLifeLineArchive(decrypted)).rejects.toThrow('Could not open this ZIP archive')
  })

  it('reuses an existing physical binary during Merge and rewrites Memory attachments', async () => {
    await seed(await fixture('incoming-media'))
    const created = await createLifeLineArchive()
    const inspected = await inspectLifeLineArchive(created.blob)
    await resetDatabase()
    const local = await fixture('local-media')
    local.data.entries = [{ ...memory('local-media'), id: 'local-memory', title: 'Local memory', peopleIds: [], placeIds: [], tagIds: [] }]
    local.data.people = []
    local.data.places = []
    local.data.tags = []
    local.data.eras = []
    local.media.placeId = undefined
    await seed(local)

    const result = await restoreLifeLineArchive(inspected, 'merge')
    const merged = await archive()
    const importedMemory = merged.entries.find(entry => entry.id === 'memory-1')!

    expect(result.reusedMedia).toBe(1)
    expect(await db.media.count()).toBe(1)
    expect(await db.mediaFiles.count()).toBe(1)
    expect(importedMemory.mediaIds).toEqual(['local-media'])
    expect(merged.media?.[0].placeId).toBe('place-1')
  })

  it('reports missing media before changing the database', async () => {
    const existing = await fixture('existing')
    await seed(existing)
    const incoming = await fixture()
    const descriptor = {
      mediaId: incoming.media.id, path: 'media/missing.bin', byteSize: bytes.length,
      contentHash: incoming.media.contentHash!, mimeType: incoming.media.mimeType, filename: incoming.media.filename,
    }
    const zip = await makeZip(createArchiveManifest(incoming.data, [descriptor]), incoming.data)

    await expect(inspectLifeLineArchive(zip)).rejects.toThrow('missing original media')
    expect((await db.entries.get('memory-1'))?.title).toBe('Archived memory')
    expect(await db.media.count()).toBe(1)
  })

  it('reports corrupted media hashes before changing the database', async () => {
    const existing = await fixture('existing')
    existing.data.entries[0].id = 'existing-memory'
    await seed(existing)
    const incoming = await fixture()
    const wrongHash = 'f'.repeat(64)
    incoming.media.contentHash = wrongHash
    const descriptor = {
      mediaId: incoming.media.id, path: 'media/one.bin', byteSize: bytes.length,
      contentHash: wrongHash, mimeType: incoming.media.mimeType, filename: incoming.media.filename,
    }
    const zip = await makeZip(createArchiveManifest(incoming.data, [descriptor]), incoming.data, new Map([[descriptor.path, new Blob([bytes])]]))

    await expect(inspectLifeLineArchive(zip)).rejects.toThrow('SHA-256 integrity check')
    expect(await db.entries.count()).toBe(1)
    expect(await db.media.count()).toBe(1)
  })

  it('rejects invalid ZIP data without modifying existing records', async () => {
    await seed(await fixture())
    await expect(inspectLifeLineArchive(new Blob(['not a zip']))).rejects.toThrow('Could not open this ZIP archive')
    expect((await db.entries.get('memory-1'))?.body).toBe('Preserved story')
    expect(await db.mediaFiles.count()).toBe(1)
  })

  it('does not clear existing data if staged Replace input becomes unreadable', async () => {
    await seed(await fixture())
    const created = await createLifeLineArchive()
    const inspected = await inspectLifeLineArchive(created.blob)
    const unreadable = { ...inspected, file: new Blob(['damaged after preview']) }

    await expect(restoreLifeLineArchive(unreadable, 'replace')).rejects.toThrow('Could not open this ZIP archive')
    expect((await db.entries.get('memory-1'))?.title).toBe('Archived memory')
    expect(await db.mediaFiles.count()).toBe(1)
  })

  it('rolls back Replace if a database write fails after staging', async () => {
    await seed(await fixture())
    const created = await createLifeLineArchive()
    const inspected = await inspectLifeLineArchive(created.blob)
    const write = vi.spyOn(db.media, 'bulkPut').mockRejectedValueOnce(new Error('simulated write failure'))

    await expect(restoreLifeLineArchive(inspected, 'replace')).rejects.toThrow('simulated write failure')
    write.mockRestore()

    expect((await db.entries.get('memory-1'))?.title).toBe('Archived memory')
    expect(await db.media.count()).toBe(1)
    expect(await db.mediaFiles.count()).toBe(1)
    expect(await db.restoreFiles.count()).toBe(0)
  })
})

async function makeZip(manifest: unknown, data: Archive, media = new Map<string, Blob>()) {
  const writer = new BlobWriter('application/zip')
  const zip = new ZipWriter(writer, { useWebWorkers: false })
  await zip.add('manifest.json', new TextReader(JSON.stringify(manifest)))
  await zip.add('data.json', new TextReader(JSON.stringify(data)))
  for (const [path, blob] of media) await zip.add(path, new BlobReader(blob), { level: 0 })
  await zip.close()
  return writer.getData()
}
