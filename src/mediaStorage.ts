import { db } from './db'
import type {
  Media,
  MediaDateConfidence,
  MediaDateSource,
  MediaType,
  PhotoMetadata,
} from './types'

const typeFor = (file: File): MediaType => file.type.startsWith('image/')
  ? 'image'
  : file.type.startsWith('video/')
    ? 'video'
    : file.type.startsWith('audio/') ? 'audio' : 'document'
const keyFor = (id: string) => `media/${id}`

export interface MediaStorageInfo { usage?: number; quota?: number; persistent?: boolean }
export async function requestStoragePersistence(storage:Pick<StorageManager,'persist'>|undefined = typeof navigator === 'undefined' ? undefined : navigator.storage):Promise<'granted'|'denied'|'unsupported'|'error'> {
  if (!storage?.persist) return 'unsupported'
  try {return await storage.persist() ? 'granted' : 'denied'} catch {return 'error'}
}
export interface MediaImportMetadata {
  contentHash?: string
  captureDate?: string
  captureDateSource?: MediaDateSource
  captureDateConfidence?: MediaDateConfidence
  captureDatePrecision?: 'exact' | 'month' | 'year' | 'approximate'
  photoMetadata?: PhotoMetadata
}
export interface MediaImportResult { media: Media; duplicate: boolean }

export async function storageInfo(): Promise<MediaStorageInfo> {
  let estimate: StorageEstimate | undefined
  let persistent: boolean | undefined
  try { estimate = await navigator.storage?.estimate?.() } catch { estimate = undefined }
  try { persistent = await navigator.storage?.persisted?.() } catch { persistent = undefined }
  return { usage: estimate?.usage, quota: estimate?.quota, persistent }
}

export async function contentHashFor(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function findMediaByContentHash(contentHash: string) {
  const indexed = await db.media.where('contentHash').equals(contentHash).first()
  if (indexed) return indexed

  const legacy = await db.media.filter(item => !item.contentHash).toArray()
  for (const item of legacy) {
    const stored = await db.mediaFiles.get(item.storageKey)
    if (!stored) continue
    const legacyHash = await contentHashFor(stored.blob)
    const upgraded = { ...item, contentHash: legacyHash, version: 2 as const }
    await db.media.put(upgraded)
    if (legacyHash === contentHash) return upgraded
  }
  return undefined
}

export async function importMediaFile(file: File, metadata: MediaImportMetadata = {}): Promise<MediaImportResult> {
  const contentHash = metadata.contentHash ?? await contentHashFor(file)
  const existing = await findMediaByContentHash(contentHash)
  if (existing) return { media: existing, duplicate: true }

  const { usage = 0, quota } = await storageInfo()
  if (quota && file.size > quota - usage) throw new Error('There is not enough browser storage for this file.')

  const id = crypto.randomUUID()
  const storageKey = keyFor(id)
  const media: Media = {
    id,
    mediaType: typeFor(file),
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    byteSize: file.size,
    importedAt: new Date().toISOString(),
    storageKey,
    contentHash,
    captureDate: metadata.captureDate,
    captureDateSource: metadata.captureDateSource,
    captureDateConfidence: metadata.captureDateConfidence,
    captureDatePrecision: metadata.captureDatePrecision,
    photoMetadata: metadata.photoMetadata,
    version: 3,
  }

  await db.transaction('rw', [db.media, db.mediaFiles], async () => {
    await db.mediaFiles.put({ key: storageKey, blob: file })
    await db.media.put(media)
  })

  return { media, duplicate: false }
}

export async function saveMediaFile(file: File): Promise<Media> {
  return (await importMediaFile(file)).media
}

export async function readMediaFile(media: Media) {
  return (await db.mediaFiles.get(media.storageKey))?.blob
}

export async function createMediaUrl(media: Media) {
  const blob = await readMediaFile(media)
  return blob ? URL.createObjectURL(blob) : undefined
}

export const revokeMediaUrl = (url?: string) => { if (url) URL.revokeObjectURL(url) }

export async function createImageThumbnail(media: Media) {
  if (media.mediaType !== 'image' || media.thumbnailKey) return media
  const original = await readMediaFile(media)
  if (!original) return media
  const url = URL.createObjectURL(original)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = reject
      element.src = url
    })
    const scale = Math.min(1, 480 / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .82))
    if (!blob) return media
    const thumbnailKey = `${media.storageKey}/thumbnail`
    await db.mediaFiles.put({ key: thumbnailKey, blob })
    const updated = { ...media, width: image.width, height: image.height, thumbnailKey }
    await db.media.put(updated)
    return updated
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function mediaPreviewUrl(media: Media) {
  const preview = media.thumbnailKey ? await db.mediaFiles.get(media.thumbnailKey) : undefined
  return preview ? URL.createObjectURL(preview.blob) : createMediaUrl(media)
}

export async function deleteMediaFile(media: Media) {
  const linked = await db.entries.filter(entry => entry.deletedAt === undefined && entry.mediaIds.includes(media.id)).count()
  if (linked) throw new Error('Media is still attached to a memory. Detach it first.')
  await db.transaction('rw', [db.media, db.mediaFiles], () => Promise.all([
    db.media.delete(media.id),
    db.mediaFiles.delete(media.storageKey),
    media.thumbnailKey ? db.mediaFiles.delete(media.thumbnailKey) : Promise.resolve(),
  ]))
}
