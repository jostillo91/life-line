import { parse as parseExif } from 'exifr'
import type { MediaDateConfidence, MediaDateSource, PhotoMetadata } from './types'

type ExifParser = (input: Blob, options?: any) => Promise<Record<string, unknown> | undefined>

export interface PhotoDateSuggestion {
  date?: string
  source?: MediaDateSource
  confidence?: MediaDateConfidence
  label: string
}

export async function extractPhotoMetadata(file: File, parser: ExifParser = parseExif) {
  let result: Record<string, unknown> | undefined
  try {
    result = await parser(file, {
      pick: [
        'DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'Orientation',
        'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude',
      ],
      gps: true,
      mergeOutput: true,
      reviveValues: true,
    })
  } catch {
    result = undefined
  }

  const metadata: PhotoMetadata = {
    exifOriginalDate: normalizeMetadataDate(result?.DateTimeOriginal),
    exifCreateDate: normalizeMetadataDate(result?.CreateDate),
    fileModifiedDate: file.lastModified > 0 ? new Date(file.lastModified).toISOString() : undefined,
    latitude: coordinate(result?.latitude ?? result?.GPSLatitude),
    longitude: coordinate(result?.longitude ?? result?.GPSLongitude),
    cameraMake: text(result?.Make),
    cameraModel: text(result?.Model),
    orientation: number(result?.Orientation),
  }

  return removeEmpty(metadata)
}

export function suggestPhotoDate(filename: string, metadata: PhotoMetadata): PhotoDateSuggestion {
  if (metadata.exifOriginalDate) {
    return { date: day(metadata.exifOriginalDate), source: 'exif-original', confidence: 'high', label: 'EXIF capture date' }
  }
  if (metadata.exifCreateDate) {
    return { date: day(metadata.exifCreateDate), source: 'exif-created', confidence: 'high', label: 'Embedded create date' }
  }
  const filenameDate = parseFilenameDate(filename)
  if (filenameDate) {
    return { date: filenameDate, source: 'filename', confidence: 'medium', label: 'Filename date' }
  }
  if (metadata.fileModifiedDate) {
    return { date: day(metadata.fileModifiedDate), source: 'file-modified', confidence: 'low', label: 'File modified date' }
  }
  return { label: 'No reliable date' }
}

export function parseFilenameDate(filename: string) {
  const matches = filename.match(/(?:^|[^0-9])((?:19|20)\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[^0-9]|$)/)
  if (!matches) return undefined
  const [, year, month, date] = matches
  return validDate(Number(year), Number(month), Number(date)) ? `${year}-${month}-${date}` : undefined
}

export function mediaDateSourceLabel(source?: MediaDateSource) {
  if (!source) return 'Unknown'
  return ({
    'exif-original': 'EXIF capture date',
    'exif-created': 'Embedded create date',
    filename: 'Filename',
    'file-modified': 'File modified date',
    user: 'User confirmed',
  } satisfies Record<MediaDateSource, string>)[source]
}

function normalizeMetadataDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const date = String(value.getDate()).padStart(2, '0')
    const hour = String(value.getHours()).padStart(2, '0')
    const minute = String(value.getMinutes()).padStart(2, '0')
    const second = String(value.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${date}T${hour}:${minute}:${second}`
  }
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return undefined
  const [, year, month, date, hour, minute, second] = match
  if (!validDate(Number(year), Number(month), Number(date))) return undefined
  return hour ? `${year}-${month}-${date}T${hour}:${minute}:${second ?? '00'}` : `${year}-${month}-${date}`
}

function validDate(year: number, month: number, date: number) {
  const value = new Date(Date.UTC(year, month - 1, date))
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === date
}

function day(value: string) {
  return value.slice(0, 10)
}

function coordinate(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function removeEmpty<T extends object>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
