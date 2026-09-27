import type { Entry, EventDate } from './types'

export interface ConfirmedPhotoDate {
  date: string
  precision: 'exact' | 'month' | 'year' | 'approximate'
}

export function eventDateForPhotos(photos: ConfirmedPhotoDate[]): EventDate {
  if (!photos.length) return { precision: 'unknown', confidence: 'unknown' }
  const dates = [...new Set(photos.map(photo => photo.date).filter(Boolean))].sort()
  if (!dates.length) return { precision: 'unknown', confidence: 'unknown' }

  if (dates.length === 1) {
    const precision = photos.some(photo => photo.precision === 'approximate')
      ? 'approximate'
      : photos.reduce<ConfirmedPhotoDate['precision']>((least, photo) => {
          const ranks = { exact: 3, approximate: 3, month: 2, year: 1 }
          return ranks[photo.precision] < ranks[least] ? photo.precision : least
        }, 'exact')
    return { precision, start: normalizeForPrecision(dates[0], precision), confidence: precision === 'exact' ? 'likely' : 'approximate' }
  }

  const months = [...new Set(dates.map(date => date.slice(0, 7)))]
  if (months.length === 1) {
    return { precision: 'month', start: `${months[0]}-01`, confidence: 'approximate' }
  }

  return { precision: 'range', start: dates[0], end: dates.at(-1), confidence: 'approximate' }
}

export function photoGroupLabel(date?: string) {
  if (!date) return 'Date Unknown'
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(parsed.valueOf())) return 'Date Unknown'
  return `${parsed.getFullYear()} · ${parsed.toLocaleString(undefined, { month: 'long' })}`
}

export function attachImportedMedia(entry: Entry, mediaIds: string[], updatedAt = new Date().toISOString()) {
  return {
    ...entry,
    mediaIds: [...new Set([...entry.mediaIds, ...mediaIds])],
    updatedAt,
  }
}

function normalizeForPrecision(date: string, precision: ConfirmedPhotoDate['precision']) {
  if (precision === 'year') return `${date.slice(0, 4)}-01-01`
  if (precision === 'month') return `${date.slice(0, 7)}-01`
  return date.slice(0, 10)
}
