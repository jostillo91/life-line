import { describe, expect, it } from 'vitest'
import {
  assignPlaceToMedia,
  clusterNearbyMedia,
  haversineDistanceMeters,
  matchPlaces,
  placeFromCluster,
  suggestedPlaceForMemory,
  validCoordinates,
} from './locationDomain'
import type { Entry, Media, Place } from './types'

const photo = (id: string, latitude?: number, longitude?: number, placeId?: string): Media => ({
  id,
  mediaType: 'image',
  filename: `${id}.jpg`,
  mimeType: 'image/jpeg',
  byteSize: 10,
  importedAt: '2026-09-21T00:00:00Z',
  captureDate: '2014-06-12',
  photoMetadata: latitude === undefined || longitude === undefined ? undefined : { latitude, longitude },
  placeId,
  storageKey: `media/${id}`,
  version: 3,
})

const memory = (mediaIds: string[]): Entry => ({
  id: 'memory',
  title: 'Memory',
  body: '',
  entryType: 'memory',
  eventDate: { precision: 'unknown', confidence: 'unknown' },
  recordTime: '2026-09-21T00:00:00Z',
  createdAt: '2026-09-21T00:00:00Z',
  updatedAt: '2026-09-21T00:00:00Z',
  importance: 1,
  status: 'active',
  peopleIds: [],
  placeIds: [],
  tagIds: [],
  mediaIds,
  relatedEntryIds: [],
})

describe('local GPS and Place suggestions', () => {
  it('validates latitude and longitude ranges', () => {
    expect(validCoordinates({ latitude: 33.4484, longitude: -112.074 })).toBe(true)
    expect(validCoordinates({ latitude: 91, longitude: 0 })).toBe(false)
    expect(validCoordinates({ latitude: 0, longitude: -181 })).toBe(false)
    expect(validCoordinates({ latitude: Number.NaN, longitude: 0 })).toBe(false)
    expect(validCoordinates({ latitude: 0 })).toBe(false)
  })

  it('uses Haversine distance in meters', () => {
    const distance = haversineDistanceMeters(
      { latitude: 33, longitude: -112 },
      { latitude: 33.001, longitude: -112 },
    )
    expect(distance).toBeGreaterThan(110)
    expect(distance).toBeLessThan(112)
  })

  it('clusters nearby photos while leaving photos outside the radius separate', () => {
    const clusters = clusterNearbyMedia([
      photo('home-1', 33.4484, -112.0740),
      photo('home-2', 33.4488, -112.0742),
      photo('few-hundred-meters-away', 33.4515, -112.0740),
      photo('far-away', 34.0489, -111.0937),
      photo('no-gps'),
    ], 150)

    expect(clusters.map(cluster => cluster.media.map(item => item.id))).toContainEqual(['home-1', 'home-2'])
    expect(clusters.filter(cluster => cluster.media.length === 1)).toHaveLength(2)
  })

  it('suggests one nearby Place conservatively', () => {
    const places: Place[] = [
      { id: 'home', name: 'Home', latitude: 33.44845, longitude: -112.074 },
      { id: 'park', name: 'Far Park', latitude: 33.46, longitude: -112.08 },
    ]
    const match = matchPlaces({ latitude: 33.4484, longitude: -112.074 }, places)

    expect(match.suggested?.place.id).toBe('home')
    expect(match.ambiguous).toBe(false)
  })

  it('does not auto-select similarly close Places', () => {
    const places: Place[] = [
      { id: 'north', name: 'North Gate', latitude: 33.4488, longitude: -112.074 },
      { id: 'south', name: 'South Gate', latitude: 33.4480, longitude: -112.074 },
    ]
    const match = matchPlaces({ latitude: 33.4484, longitude: -112.074 }, places)

    expect(match.ambiguous).toBe(true)
    expect(match.suggested).toBeUndefined()
    expect(match.candidates).toHaveLength(2)
  })

  it('creates a named Place at the arithmetic cluster center', () => {
    const cluster = clusterNearbyMedia([
      photo('one', 33.4484, -112.0740),
      photo('two', 33.4486, -112.0742),
    ])[0]
    const place = placeFromCluster(cluster, " Grandma's House ", ' Family home ', 'place-1')

    expect(place).toMatchObject({ id: 'place-1', name: "Grandma's House", description: 'Family home' })
    expect(place.latitude).toBeCloseTo(33.4485)
    expect(place.longitude).toBeCloseTo(-112.0741)
  })

  it('bulk assigns and removes a Place without mutating unselected media', () => {
    const source = [photo('one', 33, -112), photo('two', 33, -112), photo('three', 33, -112)]
    const assigned = assignPlaceToMedia(source, ['one', 'two'], 'home')
    const removed = assignPlaceToMedia(assigned, ['two'], undefined)

    expect(assigned.map(item => item.placeId)).toEqual(['home', 'home', undefined])
    expect(removed.map(item => item.placeId)).toEqual(['home', undefined, undefined])
    expect(source.every(item => item.placeId === undefined)).toBe(true)
  })

  it('suggests a shared confirmed media Place without changing the memory', () => {
    const entry = memory(['one', 'two'])
    const originalPlaces = [...entry.placeIds]
    const suggestion = suggestedPlaceForMemory(entry, [photo('one', 33, -112, 'home'), photo('two', 33, -112, 'home')])

    expect(suggestion).toBe('home')
    expect(entry.placeIds).toEqual(originalPlaces)
  })

  it('makes no recommendation when attached media have conflicting Places', () => {
    const entry = memory(['one', 'two'])
    expect(suggestedPlaceForMemory(entry, [
      photo('one', 33, -112, 'home'),
      photo('two', 33, -112, 'school'),
    ])).toBeUndefined()
  })
})
