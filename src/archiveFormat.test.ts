import { describe, expect, it } from 'vitest'
import {
  ArchiveValidationError,
  createArchiveManifest,
  migrateAndValidateArchive,
  planArchiveMerge,
  prepareReplaceData,
  type ArchiveMediaFile,
} from './archiveFormat'
import type { Archive, Entry, Media } from './types'

const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1', title: 'A summer', body: 'Story', entryType: 'memory',
    eventDate: { precision: 'range', start: '2014-06-01', end: '2014-08-31', confidence: 'approximate' },
    recordTime: '2026-09-22T00:00:00Z', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
    importance: 2, status: 'active', peopleIds: ['person-1'], placeIds: ['place-1'], tagIds: ['tag-1'],
    mediaIds: ['media-1'], relatedEntryIds: [], ...overrides,
  }
}

function media(overrides: Partial<Media> = {}): Media {
  return {
    id: 'media-1', mediaType: 'image', filename: 'photo.jpg', mimeType: 'image/jpeg', byteSize: 5,
    importedAt: '2026-09-22T00:00:00Z', storageKey: 'media/media-1', contentHash: hashA,
    captureDate: '2014-06-12', captureDateSource: 'exif-original', captureDateConfidence: 'high', captureDatePrecision: 'exact',
    photoMetadata: { latitude: 33.4484, longitude: -112.074, cameraMake: 'Canon', cameraModel: 'EOS' },
    placeId: 'place-1', version: 3, ...overrides,
  }
}

function data(overrides: Partial<Archive> = {}): Archive {
  return {
    entries: [entry()],
    people: [{ id: 'person-1', name: 'Alice' }],
    places: [{ id: 'place-1', name: 'Home', latitude: 33.4484, longitude: -112.074 }],
    tags: [{ id: 'tag-1', name: 'Family', color: '#fff' }],
    eras: [{ id: 'era-1', name: 'School Years', start: '2010-01-01' }],
    media: [media()],
    ...overrides,
  }
}

function file(overrides: Partial<ArchiveMediaFile> = {}): ArchiveMediaFile {
  return { mediaId: 'media-1', path: 'media/00000001.bin', byteSize: 5, contentHash: hashA, mimeType: 'image/jpeg', filename: 'photo.jpg', ...overrides }
}

describe('Life Line archive format', () => {
  it('generates a versioned manifest with counts and media bytes', () => {
    const manifest = createArchiveManifest(data(), [file()], '2026-09-22T12:00:00Z')
    expect(manifest).toMatchObject({
      format: 'life-line-full-archive', archiveVersion: 3, appSchemaVersion: 8,
      exportedAt: '2026-09-22T12:00:00Z', thumbnailPolicy: 'regenerate', totalMediaBytes: 5,
      counts: { memories: 1, media: 1, people: 1, places: 1, tags: 1, eras: 1, revisions: 0 },
    })
  })

  it('validates full structured data without simplifying uncertain dates or metadata', () => {
    const source = data()
    const validated = migrateAndValidateArchive(createArchiveManifest(source, [file()]), source)
    expect(validated.data.entries[0].eventDate).toEqual(source.entries[0].eventDate)
    expect(validated.data.entries[0].mediaIds).toEqual(['media-1'])
    expect(validated.data.media?.[0]).toMatchObject({ contentHash: hashA, placeId: 'place-1', photoMetadata: { cameraModel: 'EOS' } })
  })

  it('rejects unsupported future archive versions cleanly', () => {
    const source = data()
    const manifest = { ...createArchiveManifest(source, [file()]), archiveVersion: 99 }
    expect(() => migrateAndValidateArchive(manifest, source)).toThrow('newer than this version')
  })

  it('rejects missing relationships before restore planning', () => {
    const source = data({ entries: [entry({ peopleIds: ['missing-person'] })] })
    expect(() => migrateAndValidateArchive(createArchiveManifest(source, [file()]), source)).toThrow(ArchiveValidationError)
  })

  it('prepares Replace records with stable IDs and regenerable thumbnails removed', () => {
    const prepared = prepareReplaceData(data({ media: [media({ thumbnailKey: 'media/media-1/thumb' })] }))
    expect(prepared.entries[0].id).toBe('entry-1')
    expect(prepared.media?.[0]).toMatchObject({ id: 'media-1', storageKey: 'media/media-1' })
    expect(prepared.media?.[0].thumbnailKey).toBeUndefined()
  })

  it('remaps colliding entity and Memory IDs while preserving relationships', () => {
    const local = data({
      entries: [entry({ title: 'Local memory', mediaIds: [], placeIds: [], tagIds: [] })],
      people: [{ id: 'person-1', name: 'Local Alice' }], media: [],
    })
    const incoming = data({ entries: [entry({ title: 'Incoming memory' })] })
    const ids = ['person-new', 'entry-new']
    const plan = planArchiveMerge(local, incoming, () => ids.shift()!)
    const imported = plan.data.entries.find(item => item.title === 'Incoming memory')!

    expect(plan.data.people).toContainEqual({ id: 'person-new', name: 'Alice' })
    expect(imported.id).toBe('entry-new')
    expect(imported.peopleIds).toEqual(['person-new'])
    expect(imported.mediaIds).toEqual(['media-1'])
    expect(imported.placeIds).toEqual(['place-1'])
  })

  it('reuses duplicate media content and rewrites attachment IDs in order', () => {
    const localMedia = media({ id: 'local-media', storageKey: 'media/local-media' })
    const local = data({ entries: [], media: [localMedia] })
    const incoming = data({ entries: [entry({ mediaIds: ['media-1'] })], media: [media()] })
    const plan = planArchiveMerge(local, incoming)

    expect(plan.data.media).toHaveLength(1)
    expect(plan.data.entries[0].mediaIds).toEqual(['local-media'])
    expect(plan.reusedMedia).toBe(1)
    expect(plan.mediaSources.size).toBe(0)
  })

  it('keeps same-filename media distinct when hashes differ', () => {
    const local = data({ entries: [], media: [media({ id: 'local', storageKey: 'media/local' })] })
    const incoming = data({ entries: [], media: [media({ id: 'incoming', contentHash: hashB })] })
    const plan = planArchiveMerge(local, incoming)
    expect(plan.data.media?.map(item => item.id)).toEqual(['local', 'incoming'])
    expect(plan.mediaSources.get('incoming')).toBe('incoming')
  })

  it('does not duplicate semantically identical entities with different IDs', () => {
    const local = data({ entries: [], people: [{ id: 'local-person', name: 'Alice' }], media: [] })
    const incoming = data({ entries: [], people: [{ id: 'incoming-person', name: 'Alice' }], media: [] })
    const plan = planArchiveMerge(local, incoming)
    expect(plan.data.people).toEqual([{ id: 'local-person', name: 'Alice' }])
  })
})
