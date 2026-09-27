import type { Archive, Entry, EventDate, Media } from './types'

/** Deterministic metadata-only fixture. Never passed to seed(), importArchive(), or IndexedDB. */
export function createTimelineFixture(count = 2000): Archive {
  const media: Media[] = [], entries: Entry[] = []
  for (let index = 0; index < count; index++) {
    const year = 1950 + index % 91, month = String(index % 12 + 1).padStart(2, '0')
    const date = `${year}-${month}-${String(index % 27 + 1).padStart(2, '0')}`
    const precision = (['exact', 'year', 'month', 'approximate', 'range', 'season', 'age', 'unknown'] as const)[index % 8]
    const eventDate: EventDate = { precision, start: date, confidence: precision === 'exact' ? 'confirmed' : 'approximate',
      ...(precision === 'range' ? { end: `${year + 3}-${month}-28` } : {}),
      ...(precision === 'season' ? { season: 'Summer' as const } : {}),
      ...(precision === 'age' ? { start: undefined, age: index % 50 } : {}),
      ...(precision === 'unknown' ? { start: undefined } : {}) }
    const mediaIds = Array.from({ length: index % 13 }, (_, photo) => `fixture-media-${index}-${photo}`)
    media.push(...mediaIds.map(id => ({ id, mediaType: 'image' as const, filename: `${id}.jpg`, mimeType: 'image/jpeg', byteSize: 100000,
      importedAt: '2026-01-01T00:00:00Z', storageKey: `fixture/${id}`, version: 3 as const })))
    entries.push({ id: `fixture-${index}`, title: `Synthetic ${precision} memory ${index + 1}`, body: 'Development fixture only. No personal archive records or photo binaries are created.',
      entryType: index % 73 === 0 ? 'milestone' : 'memory', eventDate, importance: index % 73 === 0 ? 5 : 2,
      status: 'active', recordTime: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      peopleIds: index % 2 ? ['fixture-dad'] : [], placeIds: ['fixture-home'], tagIds: ['fixture-family'], mediaIds, relatedEntryIds: [] })
  }
  return { entries, media, people: [{ id: 'fixture-dad', name: 'Synthetic Dad' }], places: [{ id: 'fixture-home', name: 'Synthetic Home' }],
    tags: [{ id: 'fixture-family', name: 'Synthetic Family', color: '#466d50' }],
    eras: [{ id: 'fixture-era', name: 'Synthetic School Years', start: '2006-01-01', end: '2010-12-31' },
      { id: 'fixture-era-overlap', name: 'Synthetic Family Years', start: '2000-01-01', end: '2020-12-31' }],
    profile: { birthDate: '1990-06-15' } }
}
