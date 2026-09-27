import { describe, expect, it, vi } from 'vitest'
import { coordinateCacheKey, createMapTilerGeocoder, normalizeMapTilerResult } from './reverseGeocoder'
import { preparePlaceForSave } from './placeEditing'

const coordinates = { latitude: 33.4484, longitude: -112.074 }
const payload = { features: [{ place_name: 'Phoenix, Arizona, United States', address: '123 Example St', context: [
  { id: 'place.1', text: 'Phoenix' }, { id: 'region.1', text: 'Arizona' }, { id: 'country.1', text: 'United States' },
] }] }

describe('explicit reverse geocoding', () => {
  it('normalizes provider data into Place-independent suggestion fields', () => {
    expect(normalizeMapTilerResult(payload)).toEqual({
      label: 'Phoenix, Arizona, United States', address: '123 Example St', locality: undefined,
      city: 'Phoenix', region: 'Arizona', country: 'United States', postalCode: undefined,
    })
  })

  it('makes no request until lookup is called, then caches nearby repeat lookups locally', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
    const cache = new Map<string, string>()
    const storage = { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => { cache.set(key, value) } }
    const geocoder = createMapTilerGeocoder('test-key', { fetcher, storage, now: () => 1000 })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await geocoder.lookup(coordinates)).toMatchObject({ city: 'Phoenix' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toContain('-112.074,33.4484.json')
    expect(await geocoder.lookup({ latitude: 33.44841, longitude: -112.07401 })).toMatchObject({ city: 'Phoenix' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(coordinateCacheKey(coordinates)).toBe(coordinateCacheKey({ latitude: 33.44841, longitude: -112.07401 }))
  })

  it('is unavailable without a configured key and limits repeat uncached requests', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
    const unavailable = createMapTilerGeocoder(undefined, { fetcher })
    expect(unavailable.status).toBe('unavailable')
    await expect(unavailable.lookup(coordinates)).rejects.toThrow('not configured')
    expect(fetcher).not.toHaveBeenCalled()
    const geocoder = createMapTilerGeocoder('test-key', { fetcher, storage: { getItem: () => null, setItem: () => undefined }, now: () => 1000 })
    await geocoder.lookup(coordinates)
    await expect(geocoder.lookup({ latitude: 34, longitude: -113 })).rejects.toThrow('wait briefly')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps a personal Place name separate and only prepares draft coordinates on save', () => {
    const original = { id: 'home', name: "Grandma's House", latitude: 33, longitude: -112 }
    const draft = { ...original, latitude: 33.4, address: '123 Example St' }
    expect(original.latitude).toBe(33)
    expect(preparePlaceForSave(original, draft)).toEqual({ ...draft, name: "Grandma's House" })
    expect(() => preparePlaceForSave(original, { ...draft, longitude: undefined })).toThrow('both a valid latitude and longitude')
  })
})
