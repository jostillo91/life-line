import Dexie from 'dexie'
import { archive, db } from './db'
import { changedMemoryFields, makeMemoryRevision, memorySnapshot, prepareRevisionRestore, revisionTimestamp } from './memoryRevisionDomain'
import type { Entry, RevisionSource } from './types'
import { requirePurgeConfirmation } from './recoveryDomain'

export interface MemorySaveOptions { source?: RevisionSource; checkpointKey?: string; requireExisting?:boolean }
export const EDITOR_CHECKPOINT_MS = 5 * 60 * 1000
export function editorCheckpointKey(sessionId: string, startedAt: number, now = Date.now()) {
  return `${sessionId}:${Math.floor(Math.max(0, now - startedAt) / EDITOR_CHECKPOINT_MS)}`
}

// All reads, checkpoint creation and the current-state write are atomic. An
// editor checkpoint key is durable, but applies only to the latest operation:
// an intervening date/restore/assistant operation starts a fresh checkpoint.
async function saveInTransaction(entry: Entry, options: MemorySaveOptions) {
  const before = await db.entries.get(entry.id)
  if(options.requireExisting && !before) throw new Error('This memory is no longer available. A stale editor cannot recreate it.')
  if (before?.deletedAt !== undefined || entry.deletedAt !== undefined) throw new Error('Restore this memory in Recovery Center before editing it.')
  const changed = before ? changedMemoryFields(before, entry) : []
  if (before && !changed.length) return before
  const latest = before ? await db.memoryRevisions.where('[memoryId+createdAt]').between([entry.id, Dexie.minKey], [entry.id, Dexie.maxKey]).last() : undefined
  const timestamp = revisionTimestamp(before,latest)
  if (before && (!options.checkpointKey || latest?.checkpointKey !== options.checkpointKey)) {
    await db.memoryRevisions.add(makeMemoryRevision(before, options.source ?? 'editor', changed, options.checkpointKey, timestamp))
  }
  const saved = { ...memorySnapshot(entry), createdAt: before?.createdAt ?? entry.createdAt, recordTime: before?.recordTime ?? entry.recordTime, updatedAt: timestamp }
  await db.entries.put(saved)
  return saved
}
export function saveMemory(entry: Entry, options: MemorySaveOptions = {}) {
  return db.transaction('rw', [db.entries, db.memoryRevisions], () => saveInTransaction(entry, options))
}
export async function memoryHistory(memoryId: string, offset = 0, limit = 20) {
  const query = db.memoryRevisions.where('[memoryId+createdAt]').between([memoryId, Dexie.minKey], [memoryId, Dexie.maxKey])
  const [revisions, total] = await Promise.all([query.clone().reverse().offset(offset).limit(limit).toArray(), query.count()])
  return { revisions, total }
}
export async function restoreMemoryRevision(memoryId: string, revisionId: string) {
  return db.transaction('rw', [db.entries,db.memoryRevisions,db.people,db.places,db.tags,db.eras,db.media,db.archiveSettings], async () => {
    const current = await db.entries.get(memoryId), revision = await db.memoryRevisions.get(revisionId)
    if (!current || current.deletedAt !== undefined || !revision || revision.memoryId !== memoryId) throw new Error('This memory or version is no longer available.')
    const { restored, warnings } = prepareRevisionRestore(current, revision.snapshot, await archive({includeDeleted:true}))
    delete restored.deletedAt
    return { entry: await saveInTransaction(restored, {source:'restore'}), warnings }
  })
}
export async function deleteMemoryWithHistory(memoryId: string) {
  return db.transaction('rw', [db.entries,db.memoryRevisions,db.semanticVectors], async () => {
    const current = await db.entries.get(memoryId)
    if (!current || current.deletedAt !== undefined) return undefined
    const latest = await db.memoryRevisions.where('[memoryId+createdAt]').between([memoryId,Dexie.minKey],[memoryId,Dexie.maxKey]).last()
    await db.memoryRevisions.add(makeMemoryRevision(current, 'delete', [], undefined, revisionTimestamp(current,latest)))
    const deletedAt = revisionTimestamp(current,latest)
    await db.entries.put({...current,deletedAt})
    await db.semanticVectors.delete(memoryId)
    return {entry:{...current,deletedAt},related:[] as Entry[]}
  })
}
export async function undoMemoryDeletion(deleted: {entry:Entry;related:Entry[]}) {
  return restoreDeletedMemory(deleted.entry.id,deleted.entry.deletedAt)
}

export async function restoreDeletedMemory(memoryId:string,expectedDeletedAt?:string) {
  return db.transaction('rw',[db.entries,db.memoryRevisions,db.people,db.places,db.tags,db.media,db.eras,db.archiveSettings,db.semanticVectors],async () => {
    const current=await db.entries.get(memoryId)
    if (!current?.deletedAt || (expectedDeletedAt && current.deletedAt !== expectedDeletedAt)) throw new Error('This deleted memory changed or is no longer available. Refresh Recovery Center.')
    const {restored,warnings}=prepareRevisionRestore(current,current,await archive({includeDeleted:true}))
    delete restored.deletedAt
    restored.updatedAt=revisionTimestamp(current,undefined)
    await db.entries.put(restored)
    await db.semanticVectors.delete(memoryId)
    return {entry:restored,warnings}
  })
}

export async function purgeDeletedMemories(targets:Array<{id:string;deletedAt:string}>,confirmation:string) {
  requirePurgeConfirmation(confirmation,targets.length)
  if(new Set(targets.map(item=>item.id)).size !== targets.length) throw new Error('Duplicate permanent-deletion targets.')
  return db.transaction('rw',[db.entries,db.memoryRevisions,db.semanticVectors,db.archiveSettings],async () => {
    for(const target of targets) {
      const entry=await db.entries.get(target.id)
      if(!entry?.deletedAt || entry.deletedAt !== target.deletedAt) throw new Error('Recovery Center changed. Review the deleted memories again before permanent deletion.')
    }
    const ids=new Set(targets.map(item=>item.id))
    for(const entry of await db.entries.toArray()) if(!ids.has(entry.id) && entry.relatedEntryIds.some(id=>ids.has(id))) {
      const changed={...entry,relatedEntryIds:entry.relatedEntryIds.filter(id=>!ids.has(id))}
      if(entry.deletedAt) await db.entries.put(changed)
      else await saveInTransaction(changed,{source:'relationship'})
    }
    for(const id of ids) {await db.memoryRevisions.where('memoryId').equals(id).delete();await db.semanticVectors.delete(id);await db.entries.delete(id)}
    await db.archiveSettings.put({key:'initialized',value:{}})
    return ids.size
  })
}
