import type { Entry, Media, Place } from './types'

export interface Coordinates {
  latitude: number
  longitude: number
}

export interface LocationCluster {
  id: string
  media: Media[]
  center: Coordinates
  captureStart?: string
  captureEnd?: string
}

export interface PlaceCandidate {
  place: Place
  distanceMeters: number
}

export interface PlaceMatch {
  candidates: PlaceCandidate[]
  suggested?: PlaceCandidate
  ambiguous: boolean
}

export const DEFAULT_CLUSTER_RADIUS_METERS = 150
export const PLACE_MATCH_RADIUS_METERS = 200
export const PLACE_AMBIGUITY_METERS = 50

export function validCoordinates(value: Partial<Coordinates> | undefined): value is Coordinates {
  return Boolean(
    value
    && typeof value.latitude === 'number'
    && Number.isFinite(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && typeof value.longitude === 'number'
    && Number.isFinite(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180,
  )
}

export function coordinatesForMedia(media: Media): Coordinates | undefined {
  const coordinates = {
    latitude: media.photoMetadata?.latitude,
    longitude: media.photoMetadata?.longitude,
  }
  return validCoordinates(coordinates) ? coordinates : undefined
}

export function coordinatesForPlace(place: Place): Coordinates | undefined {
  const coordinates = { latitude: place.latitude, longitude: place.longitude }
  return validCoordinates(coordinates) ? coordinates : undefined
}

export function haversineDistanceMeters(left: Coordinates, right: Coordinates) {
  const earthRadiusMeters = 6_371_000
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = radians(right.latitude - left.latitude)
  const longitudeDelta = radians(right.longitude - left.longitude)
  const leftLatitude = radians(left.latitude)
  const rightLatitude = radians(right.latitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine))
}

export function clusterNearbyMedia(media: Media[], radiusMeters = DEFAULT_CLUSTER_RADIUS_METERS) {
  const candidates = media
    .map(item => ({ media: item, coordinates: coordinatesForMedia(item) }))
    .filter((item): item is { media: Media; coordinates: Coordinates } => Boolean(item.coordinates))
  const visited = new Set<string>()
  const clusters: LocationCluster[] = []

  for (const candidate of candidates) {
    if (visited.has(candidate.media.id)) continue
    const members: typeof candidates = []
    const queue = [candidate]
    visited.add(candidate.media.id)

    while (queue.length) {
      const current = queue.shift()!
      members.push(current)
      for (const possible of candidates) {
        if (visited.has(possible.media.id)) continue
        if (haversineDistanceMeters(current.coordinates, possible.coordinates) <= radiusMeters) {
          visited.add(possible.media.id)
          queue.push(possible)
        }
      }
    }

    const dates = members.map(item => item.media.captureDate?.slice(0, 10)).filter((date): date is string => Boolean(date)).sort()
    clusters.push({
      id: members.map(item => item.media.id).sort().join(':'),
      media: members.map(item => item.media),
      center: clusterCenter(members.map(item => item.coordinates)),
      captureStart: dates[0],
      captureEnd: dates.at(-1),
    })
  }

  return clusters.sort((left, right) => right.media.length - left.media.length || left.id.localeCompare(right.id))
}

export function clusterCenter(coordinates: Coordinates[]): Coordinates {
  if (!coordinates.length) throw new Error('A location cluster needs at least one coordinate.')
  return {
    latitude: coordinates.reduce((sum, item) => sum + item.latitude, 0) / coordinates.length,
    longitude: coordinates.reduce((sum, item) => sum + item.longitude, 0) / coordinates.length,
  }
}

export function matchPlaces(
  coordinates: Coordinates,
  places: Place[],
  radiusMeters = PLACE_MATCH_RADIUS_METERS,
  ambiguityMeters = PLACE_AMBIGUITY_METERS,
): PlaceMatch {
  const candidates = places
    .map(place => {
      const placeCoordinates = coordinatesForPlace(place)
      return placeCoordinates ? { place, distanceMeters: haversineDistanceMeters(coordinates, placeCoordinates) } : undefined
    })
    .filter((candidate): candidate is PlaceCandidate => candidate !== undefined)
    .filter(candidate => candidate.distanceMeters <= radiusMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters)
  const ambiguous = candidates.length > 1 && candidates[1].distanceMeters - candidates[0].distanceMeters <= ambiguityMeters
  return { candidates, suggested: candidates.length && !ambiguous ? candidates[0] : undefined, ambiguous }
}

export function placeFromCluster(cluster: LocationCluster, name: string, description = '', id: string = crypto.randomUUID()): Place {
  return {
    id,
    name: name.trim(),
    description: description.trim() || undefined,
    latitude: cluster.center.latitude,
    longitude: cluster.center.longitude,
  }
}

export function assignPlaceToMedia(media: Media[], mediaIds: string[], placeId?: string) {
  const selected = new Set(mediaIds)
  return media.map(item => selected.has(item.id)
    ? { ...item, placeId, placeSuggestionIgnored: false, version: 3 as const }
    : item)
}

export function suggestedPlaceForMemory(entry: Entry, media: Media[]) {
  const attached = entry.mediaIds
    .map(id => media.find(item => item.id === id))
    .filter((item): item is Media => Boolean(item))
  const confirmed = attached.filter(item => Boolean(item.placeId))
  if (confirmed.length < 2) return undefined
  const placeIds = [...new Set(confirmed.map(item => item.placeId!))]
  return placeIds.length === 1 ? placeIds[0] : undefined
}
