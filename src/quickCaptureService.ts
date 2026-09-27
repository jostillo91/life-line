import { db } from './db'
import { saveMemory } from './memoryRevisionService'
import { capturedMemory } from './quickCaptureDomain'
import type { Entry } from './types'

export interface CaptureSaveResult { entry:Entry; warnings:string[] }
export function saveCaptureMemory(draft:Entry):Promise<CaptureSaveResult> {
  const entry = capturedMemory(draft)
  return db.transaction('rw',[db.entries,db.memoryRevisions,db.media],async () => {
    const available = await db.media.bulkGet(entry.mediaIds)
    const missing = entry.mediaIds.filter((_,index) => !available[index])
    entry.mediaIds = entry.mediaIds.filter((_,index) => Boolean(available[index]))
    if (!entry.body.trim() && !draft.title.trim() && !entry.mediaIds.length) throw new Error('The draft attachments are no longer available. Add text or another file before saving.')
    return {entry:await saveMemory(entry),warnings:missing.length ? [`${missing.length} unavailable draft attachment${missing.length === 1 ? '' : 's'} omitted. No deleted file was recreated.`] : []}
  })
}
