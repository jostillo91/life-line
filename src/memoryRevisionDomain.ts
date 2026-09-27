import type { Archive, Entry, MemoryRevision, RevisionSource } from './types'
import { validDeletionTimestamp } from './recoveryDomain'

// Identity and bookkeeping timestamps are not content. Keep this list explicit:
// snapshots never capture component state or assistant proposals.
export const revisionFields = ['title', 'body', 'entryType', 'eventDate', 'importance', 'status', 'peopleIds', 'placeIds', 'tagIds', 'mediaIds', 'relatedEntryIds', 'notes'] as const
export const revisionFieldLabels: Record<typeof revisionFields[number], string> = {
  title: 'Title', body: 'Story text', entryType: 'Kind', eventDate: 'Date and certainty', importance: 'Importance', status: 'Status',
  peopleIds: 'People', placeIds: 'Places', tagIds: 'Tags', mediaIds: 'Photos / attachments and order', relatedEntryIds: 'Related memories', notes: 'Notes',
}
export const revisionSourceLabels: Record<RevisionSource, string> = {
  editor: 'Editor checkpoint', dateMove: 'Date moved', restore: 'Before restoration', undo: 'Before undo', relationship: 'Relationships changed', media: 'Attachments changed', assistantAccepted: 'Assistant edit accepted', delete: 'Before memory deletion',
}
export function stableRevisionValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRevisionValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableRevisionValue(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
export function changedMemoryFields(before: Entry, after: Entry) {
  return revisionFields.filter(field => stableRevisionValue(before[field]) !== stableRevisionValue(after[field]))
}
export function memorySnapshot(entry: Entry): Entry {
  const content = Object.fromEntries(revisionFields.map(field => [field, structuredClone(entry[field])]))
  return { ...content, id: entry.id, createdAt: entry.createdAt, recordTime: entry.recordTime, updatedAt: entry.updatedAt, ...(entry.deletedAt !== undefined ? {deletedAt:entry.deletedAt} : {}) } as Entry
}
export function makeMemoryRevision(before: Entry, source: RevisionSource, changedFields: string[], checkpointKey?: string, createdAt = new Date().toISOString()): MemoryRevision {
  return { id: crypto.randomUUID(), memoryId: before.id, createdAt, source, snapshot: memorySnapshot(before), changedFields, ...(checkpointKey ? { checkpointKey } : {}) }
}
export function revisionTimestamp(current: Entry | undefined, latest: MemoryRevision | undefined) {
  return new Date(Math.max(Date.now(), (Date.parse(current?.updatedAt ?? '') || 0) + 1, (Date.parse(latest?.createdAt ?? '') || 0) + 1)).toISOString()
}

export function prepareRevisionRestore(current: Entry, historical: Entry, available: Pick<Archive, 'entries'|'people'|'places'|'tags'|'media'>) {
  const restored = memorySnapshot(historical)
  restored.id = current.id
  restored.createdAt = current.createdAt
  restored.recordTime = current.recordTime
  const warnings: string[] = []
  const references = [
    ['peopleIds', available.people, 'People'], ['placeIds', available.places, 'Places'], ['tagIds', available.tags, 'Tags'],
    ['mediaIds', available.media ?? [], 'Media'], ['relatedEntryIds', available.entries, 'Related memories'],
  ] as const
  for (const [field, items, label] of references) {
    const ids = new Set(items.map(item => item.id))
    const missing = restored[field].filter(id => !ids.has(id))
    if (missing.length) warnings.push(`${label}: ${missing.length} unavailable reference${missing.length === 1 ? '' : 's'} omitted (${missing.join(', ')}).`)
    restored[field] = restored[field].filter(id => ids.has(id))
  }
  return { restored, warnings }
}

// A bounded line diff keeps large diaries responsive. For very large stories the
// read-only side-by-side preview remains the comparison, without a quadratic diff.
export function bodyLineDiff(before: string, after: string): Array<{ kind: 'same'|'removed'|'added'; text: string }> | null {
  const a = before.split('\n'), b = after.split('\n')
  if (a.length * b.length > 100_000 || before.length + after.length > 100_000) return null
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
  const result: Array<{kind:'same'|'removed'|'added';text:string}> = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({kind:'same',text:a[i++]}); j++ }
    else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) result.push({kind:'removed',text:a[i++]})
    else result.push({kind:'added',text:b[j++]})
  }
  return result
}

export function validateMemoryRevisions(value: unknown): asserts value is MemoryRevision[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('Archive revision history is invalid.')
  const ids = new Set<string>()
  for (const item of value) {
    const snapshot = item?.snapshot
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.memoryId !== 'string' || !item.memoryId
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt
      || !Object.hasOwn(revisionSourceLabels, item.source) || !Array.isArray(item.changedFields) || item.changedFields.some((field: unknown) => typeof field !== 'string' || !revisionFields.includes(field as typeof revisionFields[number]))
      || (item.checkpointKey !== undefined && typeof item.checkpointKey !== 'string')
      || !snapshot || snapshot.id !== item.memoryId || typeof snapshot.title !== 'string' || typeof snapshot.body !== 'string' || !validDeletionTimestamp(snapshot.deletedAt)
      || !['story','event','journal','milestone','memory'].includes(snapshot.entryType) || !['active','archived'].includes(snapshot.status)
      || !Number.isFinite(snapshot.importance) || (snapshot.notes !== undefined && typeof snapshot.notes !== 'string')
      || ['createdAt','recordTime','updatedAt'].some(key => typeof snapshot[key] !== 'string' || !Number.isFinite(Date.parse(snapshot[key])))
      || ['peopleIds','placeIds','tagIds','mediaIds','relatedEntryIds'].some(key => !Array.isArray(snapshot[key]) || snapshot[key].some((id:unknown) => typeof id !== 'string' || !id))
      || !snapshot.eventDate || !['exact','month','year','approximate','range','season','age','unknown'].includes(snapshot.eventDate.precision)
      || !['confirmed','likely','approximate','guess','unknown'].includes(snapshot.eventDate.confidence)
      || ['start','end','display'].some(key => snapshot.eventDate[key] !== undefined && typeof snapshot.eventDate[key] !== 'string')
      || (snapshot.eventDate.age !== undefined && (!Number.isFinite(snapshot.eventDate.age) || snapshot.eventDate.age < 0))
      || (snapshot.eventDate.season !== undefined && !['Spring','Summer','Autumn','Winter'].includes(snapshot.eventDate.season))) throw new Error('An archive revision record is invalid or duplicated.')
    ids.add(item.id)
    // Explicit schema excludes arbitrary UI fields/binary payloads from imports.
    if (Object.keys(snapshot).some(key => ![...revisionFields,'id','createdAt','recordTime','updatedAt','deletedAt'].includes(key as typeof revisionFields[number]))) throw new Error('An archive revision snapshot contains unsupported fields.')
    if (Object.keys(snapshot.eventDate).some(key => !['precision','confidence','start','end','season','age','display'].includes(key))
      || Object.keys(item).some(key => !['id','memoryId','createdAt','source','snapshot','changedFields','checkpointKey'].includes(key))) throw new Error('An archive revision record contains unsupported fields.')
  }
}
