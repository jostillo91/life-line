import { dateLabel, sorted } from './date'
import { coordinatesForMedia, coordinatesForPlace, type Coordinates } from './locationDomain'
import type { Archive, Entry, LifeEra, Media, Place } from './types'

export type MapTimeFilter =
  | { kind: 'all' }
  | { kind: 'year'; year: number }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'era'; id: string }

export interface MapVisibility { places: boolean; memories: boolean; unassigned: boolean }
export interface PlaceMapPoint {
  kind: 'place'
  id: string
  coordinates: Coordinates
  coordinateSource: 'place' | 'associated-media'
  place: Place
  memories: Entry[]
  media: Media[]
  dateRange?: [string, string]
  representative?: Media
}
export interface RawMediaMapPoint {
  kind: 'unassigned'
  id: string
  coordinates: Coordinates
  media: Media
}
export type LifeMapPoint = PlaceMapPoint | RawMediaMapPoint

function yearOf(date?: string) {
  const year = date && Number(date.slice(0, 4))
  return year && Number.isInteger(year) ? year : undefined
}

function yearsForEntry(entry: Entry): [number, number] | undefined {
  const start = yearOf(entry.eventDate.start)
  const end = yearOf(entry.eventDate.end) ?? start
  return start && end ? [start, end] : undefined
}

export function timeBounds(filter: MapTimeFilter, eras: LifeEra[]): [number, number] | undefined {
  if (filter.kind === 'all') return undefined
  if (filter.kind === 'year') return [filter.year, filter.year]
  if (filter.kind === 'range') return [Math.min(filter.start, filter.end), Math.max(filter.start, filter.end)]
  const era = eras.find(item => item.id === filter.id)
  const start = yearOf(era?.start)
  const end = yearOf(era?.end) ?? start
  return start && end ? [start, end] : undefined
}

function overlaps(period: [number, number] | undefined, bounds: [number, number] | undefined) {
  return !bounds || Boolean(period && period[0] <= bounds[1] && period[1] >= bounds[0])
}

export function mapDateRange(memories: Entry[], media: Media[]): [string, string] | undefined {
  const dates = [
    ...memories.flatMap(item => [item.eventDate.start, item.eventDate.end]),
    ...media.map(item => item.captureDate),
  ].filter((date): date is string => Boolean(date)).sort()
  return dates.length ? [dates[0], dates[dates.length - 1]] : undefined
}

export function deriveLifeMapPoints(data: Archive, filter: MapTimeFilter, visibility: MapVisibility): LifeMapPoint[] {
  const bounds = timeBounds(filter, data.eras)
  const result: LifeMapPoint[] = []
  if (visibility.places || visibility.memories) {
    for (const place of data.places) {
      const placeCoordinates = coordinatesForPlace(place)
      const associated = (data.media ?? []).filter(item => item.placeId === place.id)
      const coordinates = placeCoordinates ?? associated.map(coordinatesForMedia).find((item): item is Coordinates => Boolean(item))
      if (!coordinates) continue
      const memories = sorted(data.entries.filter(item => item.deletedAt === undefined && item.placeIds.includes(place.id) && overlaps(yearsForEntry(item), bounds)))
      const media = associated.filter(item => overlaps(yearOf(item.captureDate) ? [yearOf(item.captureDate)!, yearOf(item.captureDate)!] : undefined, bounds))
      if (bounds && !memories.length && !media.length) continue
      if (!visibility.places && !memories.length) continue
      result.push({ kind: 'place', id: `place:${place.id}`, coordinates, coordinateSource: placeCoordinates ? 'place' : 'associated-media', place,
        memories: visibility.memories ? memories : [], media,
        dateRange: mapDateRange(memories, media), representative: media.find(item => item.mediaType === 'image'),
      })
    }
  }
  if (visibility.unassigned) {
    for (const media of data.media ?? []) {
      if (media.placeId) continue
      const coordinates = coordinatesForMedia(media)
      if (!coordinates || !overlaps(yearOf(media.captureDate) ? [yearOf(media.captureDate)!, yearOf(media.captureDate)!] : undefined, bounds)) continue
      result.push({ kind: 'unassigned', id: `media:${media.id}`, coordinates, media })
    }
  }
  return result
}

export function memoryMapLabel(entry: Entry) {
  return `${dateLabel(entry.eventDate)} — ${entry.title}`
}

export function mapFocusForMedia(media: Media, places: Place[], allMedia: Media[] = [media]): Coordinates | undefined {
  const place = places.find(item => item.id === media.placeId)
  return place ? mapFocusForPlace(place, allMedia) ?? coordinatesForMedia(media) : coordinatesForMedia(media)
}

export function mapFocusForPlace(place: Place, media: Media[]): Coordinates | undefined {
  return coordinatesForPlace(place)
    ?? media.filter(item => item.placeId === place.id).map(coordinatesForMedia).find((item): item is Coordinates => Boolean(item))
}
