import { describe, expect, it } from 'vitest'
import { deriveLifeMapPoints, mapFocusForMedia, mapFocusForPlace, timeBounds } from './lifeMapDomain'
import type { Archive, Entry, Media } from './types'

const memory = (id: string, year: string, placeId = 'home'): Entry => ({
  id, title: id, body: '', entryType: 'memory', eventDate: { precision: 'year', start: `${year}-01-01`, confidence: 'confirmed' },
  recordTime: '2026-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01', importance: 1, status: 'active',
  peopleIds: [], placeIds: [placeId], tagIds: [], mediaIds: [], relatedEntryIds: [],
})
const media = (id: string, placeId?: string, year = '2004'): Media => ({
  id, mediaType: 'image', filename: `${id}.jpg`, mimeType: 'image/jpeg', byteSize: 1, importedAt: '2026-01-01',
  storageKey: `media/${id}`, version: 3, captureDate: `${year}-07-01`, placeId,
  photoMetadata: { latitude: 33.45, longitude: -112.07 },
})
const data: Archive = {
  entries: [memory('birthday', '1998'), memory('christmas', '2001'), memory('summer', '2004')],
  people: [], tags: [],
  places: [{ id: 'home', name: "Grandma's House", latitude: 33.4, longitude: -112, description: 'Family gatherings' },
    { id: 'park', name: 'Park', latitude: 34, longitude: -113 }],
  eras: [{ id: 'childhood', name: 'Childhood', start: '1997-01-01', end: '2001-12-31' }],
  media: [media('confirmed', 'home'), media('unassigned')],
}
const visible = { places: true, memories: true, unassigned: true }

describe('Life Map data', () => {
  it('derives one Place point with associated memories and media, plus unassigned GPS media', () => {
    const points = deriveLifeMapPoints(data, { kind: 'all' }, visible)
    const home = points.find(point => point.kind === 'place' && point.place.id === 'home')
    expect(home).toMatchObject({ kind: 'place', coordinates: { latitude: 33.4, longitude: -112 }, dateRange: ['1998-01-01', '2004-07-01'] })
    if (home?.kind !== 'place') throw new Error('Missing Place point')
    expect(home.memories.map(item => item.id)).toEqual(['birthday', 'christmas', 'summer'])
    expect(home.media.map(item => item.id)).toEqual(['confirmed'])
    expect(points.filter(point => point.kind === 'place')).toHaveLength(2)
    expect(points.find(point => point.kind === 'unassigned')).toMatchObject({ media: { id: 'unassigned' } })
  })

  it('filters by year, range, and Life Era without multiplying Place markers', () => {
    const byYear = deriveLifeMapPoints(data, { kind: 'year', year: 2004 }, visible)
    expect(byYear.filter(point => point.kind === 'place')).toHaveLength(1)
    expect(byYear.find(point => point.kind === 'place')).toMatchObject({ memories: [{ id: 'summer' }] })
    const byRange = deriveLifeMapPoints(data, { kind: 'range', start: 1998, end: 2001 }, visible)
    expect(byRange.find(point => point.kind === 'place')).toMatchObject({ memories: [{ id: 'birthday' }, { id: 'christmas' }] })
    expect(timeBounds({ kind: 'era', id: 'childhood' }, data.eras)).toEqual([1997, 2001])
    expect(deriveLifeMapPoints(data, { kind: 'era', id: 'childhood' }, visible).find(point => point.kind === 'place'))
      .toMatchObject({ memories: [{ id: 'birthday' }, { id: 'christmas' }] })
  })

  it('honors layer controls and navigates confirmed media through its Place', () => {
    expect(deriveLifeMapPoints(data, { kind: 'all' }, { places: false, memories: false, unassigned: true }).map(point => point.kind)).toEqual(['unassigned'])
    expect(mapFocusForMedia(data.media![0], data.places)).toEqual({ latitude: 33.4, longitude: -112 })
    expect(mapFocusForMedia(data.media![1], data.places)).toEqual({ latitude: 33.45, longitude: -112.07 })
  })

  it('uses associated GPS for a confirmed Place that has no saved coordinate, without changing the Place', () => {
    const place = { id: 'unlocated', name: 'Family park' }
    const associated = media('park-photo', place.id)
    const points = deriveLifeMapPoints({ ...data, places: [place], entries: [], media: [associated] }, { kind: 'all' }, visible)
    expect(points).toMatchObject([{ kind: 'place', coordinateSource: 'associated-media', coordinates: { latitude: 33.45, longitude: -112.07 } }])
    expect(mapFocusForPlace(place, [associated])).toEqual({ latitude: 33.45, longitude: -112.07 })
    expect(place).not.toHaveProperty('latitude')
  })
})
