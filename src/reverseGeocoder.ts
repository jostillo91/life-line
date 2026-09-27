import { validCoordinates, type Coordinates } from './locationDomain'
import { requireOnline } from './networkState'

export interface AddressSuggestion {
  address?: string
  locality?: string
  city?: string
  region?: string
  country?: string
  postalCode?: string
  label: string
}

export interface ReverseGeocoder {
  status: 'available' | 'unavailable'
  providerName: string
  lookup(coordinates: Coordinates): Promise<AddressSuggestion | undefined>
}

interface MapTilerFeature {
  place_name?: unknown
  address?: unknown
  text?: unknown
  place_type?: unknown
  context?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeMapTilerResult(input: unknown): AddressSuggestion | undefined {
  if (!input || typeof input !== 'object') return undefined
  const features = (input as { features?: unknown }).features
  if (!Array.isArray(features) || !features.length) return undefined
  const feature = features[0] as MapTilerFeature
  if (!feature || typeof feature !== 'object') return undefined
  const context = Array.isArray(feature.context) ? feature.context : []
  const valueFor = (...types: string[]) => {
    const value = context.find((item: unknown) => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as { id?: unknown; place_type?: unknown }
      return types.some(type => typeof candidate.id === 'string' && candidate.id.startsWith(`${type}.`)
        || Array.isArray(candidate.place_type) && candidate.place_type.includes(type))
    }) as { text?: unknown } | undefined
    return text(value?.text)
  }
  const suggestion: AddressSuggestion = {
    address: text(feature.address),
    locality: valueFor('neighborhood', 'locality'),
    city: valueFor('place', 'municipality', 'city'),
    region: valueFor('region', 'province', 'state'),
    country: valueFor('country'),
    postalCode: valueFor('postcode', 'postal_code'),
    label: text(feature.place_name) ?? text(feature.text) ?? '',
  }
  return suggestion.label ? suggestion : undefined
}

export function coordinateCacheKey(coordinates: Coordinates) {
  // About 11 metres in latitude; close repeat taps share one local result.
  return `${coordinates.latitude.toFixed(4)},${coordinates.longitude.toFixed(4)}`
}

export function createMapTilerGeocoder(
  apiKey: string | undefined,
  options: { fetcher?: typeof fetch; storage?: Pick<Storage, 'getItem' | 'setItem'>; now?: () => number } = {},
): ReverseGeocoder {
  const fetcher = options.fetcher ?? fetch
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const now = options.now ?? Date.now
  let nextRequestAt = 0
  let inFlight = false
  return {
    status: apiKey ? 'available' : 'unavailable',
    providerName: 'MapTiler',
    async lookup(coordinates) {
      if (!apiKey) throw new Error('Address lookup is not configured.')
      if (!validCoordinates(coordinates)) throw new Error('Enter valid coordinates before looking up an address.')
      const key = `life-line:geocode:maptiler:v1:${coordinateCacheKey(coordinates)}`
      try {
        const saved = storage?.getItem(key)
        if (saved) return JSON.parse(saved) as AddressSuggestion
      } catch { /* Storage may be unavailable; lookup can still proceed. */ }
      if (inFlight || now() < nextRequestAt) throw new Error('Please wait briefly before another address lookup.')
      requireOnline('Address lookup')
      inFlight = true
      nextRequestAt = now() + 1500
      try {
        const url = new URL(`https://api.maptiler.com/geocoding/${coordinates.longitude},${coordinates.latitude}.json`)
        url.searchParams.set('key', apiKey)
        url.searchParams.set('limit', '1')
        const response = await fetcher(url.toString(), { method: 'GET' })
        if (!response.ok) throw new Error('Address lookup is temporarily unavailable.')
        const result = normalizeMapTilerResult(await response.json())
        if (result) {
          try { storage?.setItem(key, JSON.stringify(result)) } catch { /* Cache is best-effort. */ }
        }
        return result
      } finally { inFlight = false }
    },
  }
}

export const reverseGeocoder = createMapTilerGeocoder(import.meta.env.VITE_LIFE_MAP_GEOCODER_KEY)
