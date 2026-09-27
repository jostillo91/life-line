import type { Archive, Entry, LifeEra, Media, MemoryRevision, Person, Place, Tag } from './types'
import { calendarDate } from './timelineLayout'
import { stableRevisionValue, validateMemoryRevisions } from './memoryRevisionDomain'
import { isDeletedMemory, validDeletionTimestamp } from './recoveryDomain'

export const LIFE_LINE_ARCHIVE_FORMAT = 'life-line-full-archive'
export const CURRENT_ARCHIVE_VERSION = 3
export const CURRENT_APP_SCHEMA_VERSION = 8

export interface ArchiveMediaFile {
  mediaId: string
  path: string
  byteSize: number
  contentHash: string
  mimeType: string
  filename: string
}

export interface LifeLineArchiveManifest {
  format: typeof LIFE_LINE_ARCHIVE_FORMAT
  archiveVersion: number
  appSchemaVersion: number
  exportedAt: string
  thumbnailPolicy: 'regenerate'
  counts: {
    memories: number
    media: number
    people: number
    places: number
    tags: number
    eras: number
    revisions?: number
    deletedMemories?: number
  }
  totalMediaBytes: number
  mediaFiles: ArchiveMediaFile[]
}

export interface ValidatedArchiveContents {
  manifest: LifeLineArchiveManifest
  data: Archive
}

export interface MergePlan {
  data: Archive
  mediaSources: Map<string, string>
  reusedMedia: number
  remappedIds: number
}

type Entity = Entry | Person | Place | Tag | LifeEra

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveValidationError'
  }
}

export function createArchiveManifest(data: Archive, mediaFiles: ArchiveMediaFile[], exportedAt = new Date().toISOString()): LifeLineArchiveManifest {
  return {
    format: LIFE_LINE_ARCHIVE_FORMAT,
    archiveVersion: CURRENT_ARCHIVE_VERSION,
    appSchemaVersion: CURRENT_APP_SCHEMA_VERSION,
    exportedAt,
    thumbnailPolicy: 'regenerate',
    counts: {
      memories: data.entries.length,
      deletedMemories: data.entries.filter(isDeletedMemory).length,
      media: data.media?.length ?? 0,
      people: data.people.length,
      places: data.places.length,
      tags: data.tags.length,
      eras: data.eras.length,
      revisions: data.revisions?.length ?? 0,
    },
    totalMediaBytes: mediaFiles.reduce((sum, item) => sum + item.byteSize, 0),
    mediaFiles,
  }
}

export function migrateAndValidateArchive(manifestValue: unknown, dataValue: unknown): ValidatedArchiveContents {
  const manifest = validateManifest(manifestValue)
  if (manifest.archiveVersion > CURRENT_ARCHIVE_VERSION) {
    throw new ArchiveValidationError(`Archive version ${manifest.archiveVersion} is newer than this version of Life Line supports.`)
  }
  if (manifest.archiveVersion < 1) throw new ArchiveValidationError('Archive version is invalid.')

  const migrated = migrateArchiveData(manifest.archiveVersion, dataValue)
  const data = validateData(migrated)
  validateCounts(manifest, data)
  validateRelationships(data)
  validateMediaManifest(manifest, data)
  return { manifest, data }
}

export function prepareReplaceData(data: Archive) {
  return {
    ...(data.profile ? { profile: structuredClone(data.profile) } : {}),
    entries: structuredClone(data.entries),
    people: structuredClone(data.people),
    places: structuredClone(data.places),
    tags: structuredClone(data.tags),
    eras: structuredClone(data.eras),
    revisions: structuredClone(data.revisions ?? []),
    media: (data.media ?? []).map(item => ({
      ...structuredClone(item),
      storageKey: `media/${item.id}`,
      thumbnailKey: undefined,
      version: 3 as const,
    })),
  } satisfies Archive
}

export function planArchiveMerge(local: Archive, incoming: Archive, idFactory: () => string = () => crypto.randomUUID()): MergePlan {
  const people = mergeEntities(local.people, incoming.people, idFactory)
  const places = mergeEntities(local.places, incoming.places, idFactory)
  const tags = mergeEntities(local.tags, incoming.tags, idFactory)
  const eras = mergeEntities(local.eras, incoming.eras, idFactory)
  let remappedIds = people.remapped + places.remapped + tags.remapped + eras.remapped

  const localMedia = (local.media ?? []).map(item => structuredClone(item))
  const mediaById = new Map(localMedia.map(item => [item.id, item]))
  const mediaByHash = new Map(localMedia.filter(item => item.contentHash).map(item => [item.contentHash!, item]))
  const mediaIdMap = new Map<string, string>()
  const mediaSources = new Map<string, string>()
  let reusedMedia = 0

  for (const source of incoming.media ?? []) {
    const incomingPlaceId = source.placeId ? places.idMap.get(source.placeId) ?? source.placeId : undefined
    const duplicate = source.contentHash ? mediaByHash.get(source.contentHash) : undefined
    if (duplicate) {
      mediaIdMap.set(source.id, duplicate.id)
      reusedMedia += 1
      if (!duplicate.placeId && incomingPlaceId) duplicate.placeId = incomingPlaceId
      continue
    }

    let finalId = source.id
    if (mediaById.has(finalId)) {
      finalId = uniqueId(new Set(mediaById.keys()), idFactory)
      remappedIds += 1
    }
    mediaIdMap.set(source.id, finalId)
    const media: Media = {
      ...structuredClone(source),
      id: finalId,
      placeId: incomingPlaceId,
      storageKey: `media/${finalId}`,
      thumbnailKey: undefined,
      version: 3,
    }
    localMedia.push(media)
    mediaById.set(finalId, media)
    if (media.contentHash) mediaByHash.set(media.contentHash, media)
    mediaSources.set(finalId, source.id)
  }

  const localHistoryOwners = new Set((local.revisions ?? []).map(item => item.memoryId))
  const entryIds = new Set([...local.entries.map(item => item.id), ...incoming.entries.map(item => item.id), ...localHistoryOwners])
  const entryIdMap = new Map<string, string>()
  const conflictingEntryIds = new Set(incoming.entries
    .filter(source => {
      const existing = local.entries.find(item => item.id === source.id)
      return Boolean(existing && (!sameValue(existing, source) || hasRemappedId(source.peopleIds, people.idMap) || hasRemappedId(source.placeIds, places.idMap) || hasRemappedId(source.tagIds, tags.idMap) || hasRemappedId(source.mediaIds, mediaIdMap))) || (!existing && localHistoryOwners.has(source.id))
    })
    .map(item => item.id))
  // Remapping a related Memory can propagate through an otherwise identical
  // chain (or cycle). Compute that closure before assigning owner IDs.
  let changed = true
  while (changed) {
    changed = false
    for (const source of incoming.entries) if (!conflictingEntryIds.has(source.id) && local.entries.some(item => item.id === source.id) && source.relatedEntryIds.some(id => conflictingEntryIds.has(id))) {
      conflictingEntryIds.add(source.id); changed = true
    }
  }
  for (const source of incoming.entries) {
    const existing = local.entries.find(item => item.id === source.id)
    const referencesRemap = hasRemappedId(source.peopleIds, people.idMap)
      || hasRemappedId(source.placeIds, places.idMap)
      || hasRemappedId(source.tagIds, tags.idMap)
      || hasRemappedId(source.mediaIds, mediaIdMap)
      || source.relatedEntryIds.some(id => conflictingEntryIds.has(id))
    if ((!existing && !localHistoryOwners.has(source.id)) || (existing && sameValue(existing, source) && !referencesRemap && !conflictingEntryIds.has(source.id))) entryIdMap.set(source.id, source.id)
    else {
      const id = uniqueId(entryIds, idFactory)
      entryIds.add(id)
      entryIdMap.set(source.id, id)
      remappedIds += 1
    }
  }

  const entries = local.entries.map(item => structuredClone(item))
  for (const source of incoming.entries) {
    const finalId = entryIdMap.get(source.id)!
    if (entries.some(item => item.id === finalId && sameValue(item, source))) continue
    entries.push({
      ...structuredClone(source),
      id: finalId,
      peopleIds: remapIds(source.peopleIds, people.idMap),
      placeIds: remapIds(source.placeIds, places.idMap),
      tagIds: remapIds(source.tagIds, tags.idMap),
      mediaIds: remapIds(source.mediaIds, mediaIdMap),
      relatedEntryIds: remapIds(source.relatedEntryIds, entryIdMap),
    })
  }

  // Historical references may intentionally point at deleted records. Never
  // let an absent incoming entity bind to an unrelated local entity with that ID.
  const historicalMap = (mapping: Map<string,string>, localIds: string[], incomingIds: string[], references: string[]) => {
    const used = new Set([...localIds, ...incomingIds, ...mapping.values(), ...references])
    for (const id of references) if (!mapping.has(id)) {
      const finalId = localIds.includes(id) ? uniqueId(used, idFactory) : id
      if (finalId !== id) remappedIds++
      used.add(finalId); mapping.set(id, finalId)
    }
  }
  const incomingRevisions = incoming.revisions ?? []
  const revisionContent = (item: MemoryRevision) => { const {id: _id, checkpointKey: _key, ...rest} = item; return stableRevisionValue(rest) }
  for (const source of incomingRevisions) if (!entryIdMap.has(source.memoryId) && (local.revisions ?? []).some(item => revisionContent(item) === revisionContent(source))) entryIdMap.set(source.memoryId,source.memoryId)
  historicalMap(entryIdMap, [...local.entries.map(item => item.id), ...(local.revisions ?? []).map(item => item.memoryId)], incoming.entries.map(item => item.id), incomingRevisions.flatMap(item => [item.memoryId, ...item.snapshot.relatedEntryIds]))
  const trash=incoming.entries.filter(isDeletedMemory)
  historicalMap(entryIdMap, local.entries.map(item=>item.id), incoming.entries.map(item=>item.id), trash.flatMap(item=>item.relatedEntryIds))
  historicalMap(people.idMap, people.items.map(item => item.id), incoming.people.map(item => item.id), [...incomingRevisions.flatMap(item => item.snapshot.peopleIds),...trash.flatMap(item=>item.peopleIds)])
  historicalMap(places.idMap, places.items.map(item => item.id), incoming.places.map(item => item.id), [...incomingRevisions.flatMap(item => item.snapshot.placeIds),...trash.flatMap(item=>item.placeIds)])
  historicalMap(tags.idMap, tags.items.map(item => item.id), incoming.tags.map(item => item.id), [...incomingRevisions.flatMap(item => item.snapshot.tagIds),...trash.flatMap(item=>item.tagIds)])
  historicalMap(mediaIdMap, localMedia.map(item => item.id), (incoming.media ?? []).map(item => item.id), [...incomingRevisions.flatMap(item => item.snapshot.mediaIds),...trash.flatMap(item=>item.mediaIds)])
  for(const source of trash) {
    const entry=entries.find(item=>item.id===entryIdMap.get(source.id))!
    entry.peopleIds=remapIds(source.peopleIds,people.idMap);entry.placeIds=remapIds(source.placeIds,places.idMap);entry.tagIds=remapIds(source.tagIds,tags.idMap)
    entry.mediaIds=remapIds(source.mediaIds,mediaIdMap);entry.relatedEntryIds=remapIds(source.relatedEntryIds,entryIdMap)
  }
  const revisions: MemoryRevision[] = structuredClone(local.revisions ?? [])
  const revisionIds = new Set([...revisions, ...incomingRevisions].map(item => item.id))
  const knownRevisions = new Set(revisions.map(revisionContent))
  for (const source of incomingRevisions) {
    const memoryId = entryIdMap.get(source.memoryId) ?? source.memoryId
    const revision: MemoryRevision = {...structuredClone(source), memoryId, snapshot:{...structuredClone(source.snapshot), id:memoryId,
      peopleIds:remapIds(source.snapshot.peopleIds, people.idMap), placeIds:remapIds(source.snapshot.placeIds, places.idMap), tagIds:remapIds(source.snapshot.tagIds, tags.idMap),
      mediaIds:remapIds(source.snapshot.mediaIds, mediaIdMap), relatedEntryIds:remapIds(source.snapshot.relatedEntryIds, entryIdMap)}}
    const content = revisionContent(revision)
    if (knownRevisions.has(content)) continue
    if (revisions.some(item => item.id === revision.id)) { revision.id = uniqueId(revisionIds, idFactory); remappedIds++ }
    revisionIds.add(revision.id); knownRevisions.add(content); revisions.push(revision)
  }
  const data: Archive = {
    ...((local.profile?.birthDate ? local.profile : incoming.profile ?? local.profile) ? { profile: structuredClone(local.profile?.birthDate ? local.profile : incoming.profile ?? local.profile) } : {}),
    entries,
    people: people.items,
    places: places.items,
    tags: tags.items,
    eras: eras.items,
    media: localMedia,
    revisions,
  }
  validateRelationships(data)
  return { data, mediaSources, reusedMedia, remappedIds }
}

function validateManifest(value: unknown): LifeLineArchiveManifest {
  if (!isRecord(value) || value.format !== LIFE_LINE_ARCHIVE_FORMAT) throw new ArchiveValidationError('This is not a Life Line full archive.')
  if (!Number.isInteger(value.archiveVersion)) throw new ArchiveValidationError('Archive version is missing or invalid.')
  if (!Number.isInteger(value.appSchemaVersion) || typeof value.exportedAt !== 'string') throw new ArchiveValidationError('Archive manifest metadata is incomplete.')
  if (value.thumbnailPolicy !== 'regenerate' || !isRecord(value.counts) || !Array.isArray(value.mediaFiles)) throw new ArchiveValidationError('Archive manifest structure is invalid.')
  const counts = value.counts
  const countKeys = ['memories', 'media', 'people', 'places', 'tags', 'eras']
  if (Number(value.archiveVersion) >= 2) countKeys.push('revisions')
  if (Number(value.archiveVersion) >= 3) countKeys.push('deletedMemories')
  if (countKeys.some(key => !Number.isInteger(counts[key]) || Number(counts[key]) < 0)) throw new ArchiveValidationError('Archive counts are invalid.')
  if (typeof value.totalMediaBytes !== 'number' || value.totalMediaBytes < 0) throw new ArchiveValidationError('Archive media size is invalid.')
  for (const file of value.mediaFiles) {
    if (!isRecord(file)
      || typeof file.mediaId !== 'string'
      || typeof file.path !== 'string'
      || !file.path.startsWith('media/')
      || typeof file.byteSize !== 'number'
      || file.byteSize < 0
      || typeof file.contentHash !== 'string'
      || !/^[a-f0-9]{64}$/i.test(file.contentHash)
      || typeof file.mimeType !== 'string'
      || typeof file.filename !== 'string') throw new ArchiveValidationError('Archive media manifest is invalid.')
  }
  return value as unknown as LifeLineArchiveManifest
}

function migrateArchiveData(version: number, value: unknown): unknown {
  if (version === 1 || version === 2 || version === 3) return value
  throw new ArchiveValidationError(`Archive version ${version} cannot be migrated.`)
}

function validateData(value: unknown): Archive {
  if (!isRecord(value)) throw new ArchiveValidationError('Structured archive data is invalid.')
  for (const key of ['entries', 'people', 'places', 'tags', 'eras']) {
    if (!Array.isArray(value[key])) throw new ArchiveValidationError(`Structured archive data is missing ${key}.`)
  }
  if (value.media !== undefined && !Array.isArray(value.media)) throw new ArchiveValidationError('Structured archive media is invalid.')
  if (value.profile !== undefined && (!isRecord(value.profile)
    || (value.profile.birthDate !== undefined && (typeof value.profile.birthDate !== 'string'
      || value.profile.birthDate.length !== 10 || calendarDate(value.profile.birthDate) === undefined)))) {
    throw new ArchiveValidationError('Archive birth date is invalid.')
  }
  const data = value as unknown as Archive
  try { validateMemoryRevisions(data.revisions) } catch (error) { throw new ArchiveValidationError(error instanceof Error ? error.message : 'Archive history is invalid.') }
  const collections: Array<[string, Array<{ id: string }>]> = [
    ['memories', data.entries], ['people', data.people], ['places', data.places], ['tags', data.tags], ['eras', data.eras], ['media', data.media ?? []],
  ]
  for (const [label, items] of collections) {
    if (items.some(item => !isRecord(item) || typeof item.id !== 'string' || !item.id)) throw new ArchiveValidationError(`Archive ${label} contain an invalid record.`)
    if (new Set(items.map(item => item.id)).size !== items.length) throw new ArchiveValidationError(`Archive ${label} contain duplicate IDs.`)
  }
  for (const entry of data.entries) {
    if (!validDeletionTimestamp(entry.deletedAt)) throw new ArchiveValidationError('A Memory deletion timestamp is invalid.')
    if (typeof entry.title !== 'string' || !isRecord(entry.eventDate)
      || !Array.isArray(entry.peopleIds) || !Array.isArray(entry.placeIds)
      || !Array.isArray(entry.tagIds) || !Array.isArray(entry.mediaIds)
      || !Array.isArray(entry.relatedEntryIds)) throw new ArchiveValidationError('A Memory record is incomplete.')
  }
  for (const media of data.media ?? []) {
    if (typeof media.storageKey !== 'string' || typeof media.filename !== 'string' || typeof media.mimeType !== 'string') throw new ArchiveValidationError('A Media record is incomplete.')
  }
  return structuredClone(data)
}

function validateCounts(manifest: LifeLineArchiveManifest, data: Archive) {
  const actual = createArchiveManifest(data, manifest.mediaFiles, manifest.exportedAt).counts
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    if(key === 'deletedMemories' && manifest.archiveVersion < 3) continue
    if (actual[key] !== (manifest.counts[key] ?? (key === 'revisions' && manifest.archiveVersion === 1 ? 0 : undefined))) throw new ArchiveValidationError(`Archive ${key} count does not match its data.`)
  }
}

function validateRelationships(data: Archive) {
  const ids = {
    entries: new Set(data.entries.map(item => item.id)),
    people: new Set(data.people.map(item => item.id)),
    places: new Set(data.places.map(item => item.id)),
    tags: new Set(data.tags.map(item => item.id)),
    media: new Set((data.media ?? []).map(item => item.id)),
  }
  for (const entry of data.entries) {
    // Trash may retain unavailable supporting references for read-only preview.
    // Restoration filters them; normal live records remain strictly validated.
    if(isDeletedMemory(entry)) continue
    validateReferences(entry.peopleIds, ids.people, `Memory ${entry.id} has a missing Person`)
    validateReferences(entry.placeIds, ids.places, `Memory ${entry.id} has a missing Place`)
    validateReferences(entry.tagIds, ids.tags, `Memory ${entry.id} has a missing Tag`)
    validateReferences(entry.mediaIds, ids.media, `Memory ${entry.id} has missing Media`)
    validateReferences(entry.relatedEntryIds, ids.entries, `Memory ${entry.id} has a missing related Memory`)
  }
  for (const media of data.media ?? []) {
    if (media.placeId && !ids.places.has(media.placeId)) throw new ArchiveValidationError(`Media ${media.id} has a missing Place.`)
  }
}

function validateMediaManifest(manifest: LifeLineArchiveManifest, data: Archive) {
  const media = data.media ?? []
  if (manifest.mediaFiles.length !== media.length) throw new ArchiveValidationError('Archive media-file count does not match its Media records.')
  const paths = new Set<string>()
  const filesById = new Map<string, ArchiveMediaFile>()
  for (const file of manifest.mediaFiles) {
    if (paths.has(file.path)) throw new ArchiveValidationError('Archive contains duplicate media paths.')
    if (filesById.has(file.mediaId)) throw new ArchiveValidationError('Archive contains duplicate media file records.')
    paths.add(file.path)
    filesById.set(file.mediaId, file)
  }
  for (const item of media) {
    const file = filesById.get(item.id)
    if (!file) throw new ArchiveValidationError(`Archive is missing the original file for ${item.filename}.`)
    if (item.contentHash && item.contentHash !== file.contentHash) throw new ArchiveValidationError(`Archive hash metadata disagrees for ${item.filename}.`)
  }
  if (manifest.totalMediaBytes !== manifest.mediaFiles.reduce((sum, item) => sum + item.byteSize, 0)) throw new ArchiveValidationError('Archive total media size is inconsistent.')
}

function mergeEntities<T extends Entity>(local: T[], incoming: T[], idFactory: () => string) {
  const items = local.map(item => structuredClone(item))
  const idMap = new Map<string, string>()
  const used = new Set(items.map(item => item.id))
  let remapped = 0
  for (const source of incoming) {
    const sameId = items.find(item => item.id === source.id)
    if (sameId && sameValue(sameId, source)) {
      idMap.set(source.id, sameId.id)
      continue
    }
    const sameContent = items.find(item => sameValueWithoutId(item, source))
    if (sameContent) {
      idMap.set(source.id, sameContent.id)
      continue
    }
    let id = source.id
    if (used.has(id)) {
      id = uniqueId(used, idFactory)
      remapped += 1
    }
    used.add(id)
    idMap.set(source.id, id)
    items.push({ ...structuredClone(source), id })
  }
  return { items, idMap, remapped }
}

function remapIds(values: string[], mapping: Map<string, string>) {
  return values.map(id => mapping.get(id) ?? id)
}

function hasRemappedId(values: string[], mapping: Map<string, string>) {
  return values.some(id => mapping.has(id) && mapping.get(id) !== id)
}

function uniqueId(used: Set<string>, idFactory: () => string) {
  let id = idFactory()
  while (used.has(id)) id = idFactory()
  return id
}

function validateReferences(values: string[], available: Set<string>, message: string) {
  if (values.some(id => !available.has(id))) throw new ArchiveValidationError(`${message}.`)
}

function sameValue(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right)
}

function sameValueWithoutId(left: Entity, right: Entity) {
  const { id: _leftId, ...leftValue } = left
  const { id: _rightId, ...rightValue } = right
  return sameValue(leftValue, rightValue)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
