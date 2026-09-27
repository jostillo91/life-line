import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
  type Entry as ZipEntry,
  type FileEntry,
} from '@zip.js/zip.js'
import {
  createArchiveManifest,
  migrateAndValidateArchive,
  planArchiveMerge,
  prepareReplaceData,
  type ArchiveMediaFile,
  type LifeLineArchiveManifest,
} from './archiveFormat'
import { archive, db } from './db'
import { ArchiveCancelledError } from './archiveCancellation'
import { contentHashFor, readMediaFile, storageInfo } from './mediaStorage'
import type { Archive, Media } from './types'

const MANIFEST_PATH = 'manifest.json'
const DATA_PATH = 'data.json'
const MAX_STRUCTURED_DATA_BYTES = 100 * 1024 * 1024

export type ArchiveStage = 'preparing' | 'structured-data' | 'media' | 'encrypting' | 'decrypting' | 'finalizing' | 'validating' | 'staging' | 'restoring' | 'complete'
export interface ArchiveProgress {
  stage: ArchiveStage
  current?: number
  total?: number
  processedBytes?: number
  totalBytes?: number
  message: string
}

export interface CreatedLifeLineArchive {
  blob: Blob
  filename: string
  manifest: LifeLineArchiveManifest
}

export interface InspectedLifeLineArchive {
  file: Blob
  manifest: LifeLineArchiveManifest
  data: Archive
  storageWarning?: string
}

export interface RestoreResult {
  mode: 'merge' | 'replace'
  reusedMedia: number
  remappedIds: number
}

export { ArchiveCancelledError } from './archiveCancellation'

export async function createLifeLineArchive(
  onProgress?: (progress: ArchiveProgress) => void,
  signal?: AbortSignal,
): Promise<CreatedLifeLineArchive> {
  report(onProgress, { stage: 'preparing', message: 'Preparing archive' })
  throwIfAborted(signal)
  const source = await archive({includeRevisions:true,includeDeleted:true})
  const media = source.media ?? []
  const archivedMedia: Media[] = []
  const files: ArchiveMediaFile[] = []
  let processedBytes = 0
  const totalBytes = media.reduce((sum, item) => sum + item.byteSize, 0)

  for (let index = 0; index < media.length; index += 1) {
    throwIfAborted(signal)
    const item = media[index]
    const blob = await readMediaFile(item)
    if (!blob) throw new Error(`Original media is missing for ${item.filename}. Backup was not created.`)
    const hash = await contentHashFor(blob)
    if (item.contentHash && item.contentHash !== hash) throw new Error(`Stored media failed its integrity check: ${item.filename}.`)
    const path = `media/${String(index + 1).padStart(8, '0')}.bin`
    files.push({ mediaId: item.id, path, byteSize: blob.size, contentHash: hash, mimeType: item.mimeType, filename: item.filename })
    archivedMedia.push({ ...structuredClone(item), byteSize: blob.size, contentHash: hash, thumbnailKey: undefined })
    processedBytes += blob.size
    report(onProgress, { stage: 'preparing', current: index + 1, total: media.length, processedBytes, totalBytes, message: `Checking media ${index + 1} / ${media.length}` })
  }

  const data: Archive = { ...structuredClone(source), media: archivedMedia }
  const manifest = createArchiveManifest(data, files)
  report(onProgress, { stage: 'structured-data', message: 'Adding structured data', totalBytes })
  const blobWriter = new BlobWriter('application/zip')
  const zipWriter = new ZipWriter(blobWriter, { useWebWorkers: false })
  await zipWriter.add(MANIFEST_PATH, new TextReader(JSON.stringify(manifest, null, 2)))
  await zipWriter.add(DATA_PATH, new TextReader(JSON.stringify(data)))

  processedBytes = 0
  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal)
    const descriptor = files[index]
    const item = media.find(candidate => candidate.id === descriptor.mediaId)!
    const blob = await readMediaFile(item)
    if (!blob) throw new Error(`Original media disappeared while backing up ${item.filename}.`)
    await zipWriter.add(descriptor.path, new BlobReader(blob), { level: 0 })
    processedBytes += blob.size
    report(onProgress, { stage: 'media', current: index + 1, total: files.length, processedBytes, totalBytes, message: `Adding media ${index + 1} / ${files.length}` })
  }

  throwIfAborted(signal)
  report(onProgress, { stage: 'finalizing', message: 'Finalizing archive', processedBytes, totalBytes })
  await zipWriter.close()
  const blob = await blobWriter.getData()
  await inspectArchiveStructure(blob)
  report(onProgress, { stage: 'complete', current: files.length, total: files.length, processedBytes, totalBytes, message: 'Backup ready' })
  return { blob, filename: backupFilename(manifest.exportedAt), manifest }
}

export async function inspectLifeLineArchive(
  file: Blob,
  onProgress?: (progress: ArchiveProgress) => void,
  signal?: AbortSignal,
): Promise<InspectedLifeLineArchive> {
  report(onProgress, { stage: 'validating', message: 'Inspecting archive' })
  const { entries, close } = await openArchive(file)
  try {
    throwIfAborted(signal)
    const manifestEntry = requiredFile(entries, MANIFEST_PATH)
    const dataEntry = requiredFile(entries, DATA_PATH)
    if ((dataEntry.uncompressedSize ?? 0) > MAX_STRUCTURED_DATA_BYTES) throw new Error('Archive structured data is too large for this browser.')
    const manifestValue = parseJson(await manifestEntry.getData(new TextWriter()), 'manifest')
    const dataValue = parseJson(await dataEntry.getData(new TextWriter()), 'structured data')
    const validated = migrateAndValidateArchive(manifestValue, dataValue)
    const entriesByName = uniqueEntries(entries)
    let processedBytes = 0

    for (let index = 0; index < validated.manifest.mediaFiles.length; index += 1) {
      throwIfAborted(signal)
      const descriptor = validated.manifest.mediaFiles[index]
      const entry = entriesByName.get(descriptor.path)
      if (!entry || entry.directory) throw new Error(`Archive is missing original media: ${descriptor.filename}.`)
      if (entry.uncompressedSize !== descriptor.byteSize) throw new Error(`Archive media size does not match for ${descriptor.filename}.`)
      const blob = await entry.getData(new BlobWriter(descriptor.mimeType))
      const hash = await contentHashFor(blob)
      if (hash !== descriptor.contentHash) throw new Error(`Archive media failed its SHA-256 integrity check: ${descriptor.filename}.`)
      processedBytes += blob.size
      report(onProgress, {
        stage: 'validating', current: index + 1, total: validated.manifest.mediaFiles.length,
        processedBytes, totalBytes: validated.manifest.totalMediaBytes,
        message: `Validating media ${index + 1} / ${validated.manifest.mediaFiles.length}`,
      })
    }

    const info = await storageInfo()
    const available = info.quota === undefined || info.usage === undefined ? undefined : Math.max(0, info.quota - info.usage)
    const storageWarning = available !== undefined && validated.manifest.totalMediaBytes > available
      ? 'This archive may exceed the browser’s estimated available storage. Restore is disabled until space is available.'
      : available === undefined ? 'This browser could not estimate available storage.' : undefined
    return { file, ...validated, storageWarning }
  } finally {
    await close()
  }
}

export async function restoreLifeLineArchive(
  inspected: InspectedLifeLineArchive,
  mode: 'merge' | 'replace',
  onProgress?: (progress: ArchiveProgress) => void,
  signal?: AbortSignal,
): Promise<RestoreResult> {
  throwIfAborted(signal)
  if (mode === 'replace' && inspected.storageWarning?.includes('exceed')) throw new Error(inspected.storageWarning)
  const local = mode === 'merge' ? await archiveWithLocalHashes() : undefined
  const mergePlan = mode === 'merge' ? planArchiveMerge(local!, inspected.data) : undefined
  const restoredData = mode === 'merge' ? mergePlan!.data : prepareReplaceData(inspected.data)
  const mediaSources = mode === 'merge'
    ? mergePlan!.mediaSources
    : new Map((inspected.data.media ?? []).map(item => [item.id, item.id]))
  const manifestByMedia = new Map(inspected.manifest.mediaFiles.map(item => [item.mediaId, item]))
  const requiredBytes = [...mediaSources.values()].reduce((sum, sourceId) => sum + (manifestByMedia.get(sourceId)?.byteSize ?? 0), 0)
  await assertRestoreCapacity(requiredBytes)
  await db.restoreFiles.clear()

  const { entries, close } = await openArchive(inspected.file)
  try {
    const entriesByName = uniqueEntries(entries)
    let current = 0
    let processedBytes = 0
    for (const [finalMediaId, sourceMediaId] of mediaSources) {
      throwIfAborted(signal)
      const descriptor = manifestByMedia.get(sourceMediaId)
      if (!descriptor) throw new Error(`Archive media manifest is missing ${sourceMediaId}.`)
      const entry = entriesByName.get(descriptor.path)
      if (!entry || entry.directory) throw new Error(`Archive is missing original media: ${descriptor.filename}.`)
      const blob = await entry.getData(new BlobWriter(descriptor.mimeType))
      const hash = await contentHashFor(blob)
      if (hash !== descriptor.contentHash) throw new Error(`Archive media failed its SHA-256 integrity check: ${descriptor.filename}.`)
      await db.restoreFiles.put({ key: `media/${finalMediaId}`, blob })
      current += 1
      processedBytes += blob.size
      report(onProgress, { stage: 'staging', current, total: mediaSources.size, processedBytes, totalBytes: requiredBytes, message: `Staging media ${current} / ${mediaSources.size}` })
    }

    throwIfAborted(signal)
    report(onProgress, { stage: 'restoring', message: mode === 'replace' ? 'Replacing local archive safely' : 'Merging archive safely' })
    await commitRestore(restoredData, mode)
    report(onProgress, { stage: 'complete', message: 'Restore complete' })
    return { mode, reusedMedia: mergePlan?.reusedMedia ?? 0, remappedIds: mergePlan?.remappedIds ?? 0 }
  } catch (error) {
    await db.restoreFiles.clear()
    throw error
  } finally {
    await close()
  }
}

async function commitRestore(data: Archive, mode: 'merge' | 'replace') {
  await db.transaction('rw', [db.entries, db.people, db.places, db.tags, db.eras, db.media, db.mediaFiles, db.restoreFiles, db.semanticVectors, db.archiveSettings, db.memoryRevisions], async () => {
    if (mode === 'replace') {
      await Promise.all([
        db.entries.clear(), db.people.clear(), db.places.clear(), db.tags.clear(), db.eras.clear(), db.media.clear(), db.mediaFiles.clear(), db.archiveSettings.clear(), db.memoryRevisions.clear(),
      ])
    }
    await Promise.all([
      db.entries.bulkPut(data.entries),
      db.people.bulkPut(data.people),
      db.places.bulkPut(data.places),
      db.tags.bulkPut(data.tags),
      db.eras.bulkPut(data.eras),
      db.media.bulkPut(data.media ?? []),
      db.memoryRevisions.bulkPut(data.revisions ?? []),
    ])
    if (data.profile) await db.archiveSettings.put({ key: 'profile', value: data.profile })
    await db.archiveSettings.put({key:'initialized',value:{}})
    const staged = await db.restoreFiles.toArray()
    if (staged.length) await db.mediaFiles.bulkPut(staged)
    await db.restoreFiles.clear()
    // Embeddings are derived from canonical records; Merge may remap IDs, so no old vector is retained.
    await db.semanticVectors.clear()
  })
}

async function archiveWithLocalHashes() {
  const data = await archive({includeRevisions:true,includeDeleted:true})
  const media: Media[] = []
  for (const item of data.media ?? []) {
    const blob = await readMediaFile(item)
    media.push(blob ? { ...item, contentHash: await contentHashFor(blob) } : { ...item, contentHash: undefined })
  }
  return { ...data, media }
}

async function assertRestoreCapacity(requiredBytes: number) {
  const { quota, usage } = await storageInfo()
  if (quota !== undefined && usage !== undefined && requiredBytes > quota - usage) {
    throw new Error('The archive may exceed this browser’s estimated available storage. Free space or restore a smaller archive.')
  }
}

async function inspectArchiveStructure(blob: Blob) {
  const { entries, close } = await openArchive(blob)
  try {
    const manifestEntry = requiredFile(entries, MANIFEST_PATH)
    const dataEntry = requiredFile(entries, DATA_PATH)
    const manifest = JSON.parse(await manifestEntry.getData(new TextWriter())) as LifeLineArchiveManifest
    const data = JSON.parse(await dataEntry.getData(new TextWriter())) as Archive
    const validated = migrateAndValidateArchive(manifest, data)
    const names = uniqueEntries(entries)
    for (const file of validated.manifest.mediaFiles) {
      if (!names.has(file.path)) throw new Error(`Backup verification could not find ${file.filename}.`)
    }
  } finally {
    await close()
  }
}

async function openArchive(blob: Blob) {
  let reader: ZipReader<Blob>
  try {
    reader = new ZipReader(new BlobReader(blob), { strictness: 'strict', useWebWorkers: false })
    const entries = await reader.getEntries()
    return { entries, close: () => reader.close() }
  } catch (error) {
    throw new Error(`Could not open this ZIP archive. ${error instanceof Error ? error.message : ''}`.trim())
  }
}

function requiredFile(entries: ZipEntry[], name: string): FileEntry {
  const entry = entries.find(item => item.filename === name)
  if (!entry || entry.directory) throw new Error(`Archive is missing ${name}.`)
  return entry
}

function uniqueEntries(entries: ZipEntry[]) {
  const files = new Map<string, ZipEntry>()
  for (const entry of entries) {
    if (files.has(entry.filename)) throw new Error(`Archive contains a duplicate ZIP entry: ${entry.filename}.`)
    files.set(entry.filename, entry)
  }
  return files
}

function parseJson(text: string, label: string) {
  try { return JSON.parse(text) as unknown }
  catch { throw new Error(`Archive ${label} is not valid JSON.`) }
}

function backupFilename(exportedAt: string) {
  return `Life-Line-Backup-${exportedAt.slice(0, 10)}.zip`
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ArchiveCancelledError()
}

function report(callback: ((progress: ArchiveProgress) => void) | undefined, progress: ArchiveProgress) {
  callback?.(progress)
}
