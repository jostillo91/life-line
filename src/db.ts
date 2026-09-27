import Dexie, { type EntityTable } from 'dexie'
import type { Entry, Person, Place, Tag, LifeEra, Archive, ArchiveProfile, Media, MediaFile, RestoreFile, MemoryRevision } from './types'
import type { SemanticSetting, SemanticVector } from './semanticSearch'
import { detachReference } from './domain'
import { calendarDate } from './timelineLayout'
import { changedMemoryFields, makeMemoryRevision, revisionTimestamp, validateMemoryRevisions } from './memoryRevisionDomain'
import { planArchiveMerge } from './archiveFormat'
import { liveMemories, validDeletionTimestamp } from './recoveryDomain'
const revisionFixture = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('revisionFixture')
export const db = new Dexie(revisionFixture ? 'life-line-revision-fixture' : 'life-line-diary') as Dexie & { entries:EntityTable<Entry,'id'>; people:EntityTable<Person,'id'>; places:EntityTable<Place,'id'>; tags:EntityTable<Tag,'id'>; eras:EntityTable<LifeEra,'id'>; media:EntityTable<Media,'id'>; mediaFiles:EntityTable<MediaFile,'key'>; restoreFiles:EntityTable<RestoreFile,'key'>; semanticVectors:EntityTable<SemanticVector,'memoryId'>; semanticSettings:EntityTable<SemanticSetting,'key'>; archiveSettings: EntityTable<{ key: 'profile'|'initialized'; value: ArchiveProfile }, 'key'>; memoryRevisions: EntityTable<MemoryRevision,'id'> }
db.version(1).stores({ entries:'id, entryType, updatedAt, *tagIds, *peopleIds', people:'id,name', places:'id,name', tags:'id,name', eras:'id,name' })
db.version(2).stores({ entries:'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people:'id,name', places:'id,name', tags:'id,name', eras:'id,name', media:'id,mediaType,filename,importedAt', mediaFiles:'key' })
db.version(3).stores({ entries:'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people:'id,name', places:'id,name', tags:'id,name', eras:'id,name', media:'id,mediaType,filename,importedAt,contentHash,captureDate', mediaFiles:'key' })
db.version(4).stores({ entries:'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people:'id,name', places:'id,name', tags:'id,name', eras:'id,name', media:'id,mediaType,filename,importedAt,contentHash,captureDate,placeId', mediaFiles:'key' })
db.version(5).stores({ entries:'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people:'id,name', places:'id,name', tags:'id,name', eras:'id,name', media:'id,mediaType,filename,importedAt,contentHash,captureDate,placeId', mediaFiles:'key', restoreFiles:'key' })
db.version(6).stores({ entries:'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people:'id,name', places:'id,name', tags:'id,name', eras:'id,name', media:'id,mediaType,filename,importedAt,contentHash,captureDate,placeId', mediaFiles:'key', restoreFiles:'key', semanticVectors:'memoryId,model,indexVersion', semanticSettings:'key' })
db.version(7).stores({ archiveSettings: 'key' })
db.version(8).stores({ memoryRevisions: 'id,memoryId,createdAt,[memoryId+createdAt],[memoryId+checkpointKey]' })
// Internal initialization metadata is not part of the exported archive profile.
// An intentionally empty archive must not be repopulated with demo memories.
export async function initializeArchive(initial:Archive) {
  await db.transaction('rw',[db.entries,db.people,db.places,db.tags,db.eras,db.archiveSettings,db.memoryRevisions],async()=>{
    if(await db.archiveSettings.get('initialized')) return
    if(await db.entries.count() === 0 && await db.memoryRevisions.count() === 0) {
      await Promise.all([db.entries.bulkAdd(initial.entries),db.people.bulkAdd(initial.people),db.places.bulkAdd(initial.places),db.tags.bulkAdd(initial.tags),db.eras.bulkAdd(initial.eras)])
    }
    await db.archiveSettings.put({key:'initialized',value:{}})
  })
}
export async function archive(options: { includeRevisions?: boolean; includeDeleted?:boolean } = {}):Promise<Archive> {
  const read = async () => {
    const [entries,people,places,tags,eras,media,profile,revisions] = await Promise.all([db.entries.toArray(),db.people.toArray(),db.places.toArray(),db.tags.toArray(),db.eras.toArray(),db.media.toArray(),db.archiveSettings.get('profile'),options.includeRevisions ? db.memoryRevisions.toArray() : undefined])
    return {entries:options.includeDeleted ? entries : liveMemories(entries),people,places,tags,eras,media,...(profile ? {profile:profile.value} : {}),...(options.includeRevisions ? {revisions} : {})}
  }
  // Pair canonical states and their checkpoints consistently during export.
  return options.includeRevisions ? db.transaction('r',[db.entries,db.people,db.places,db.tags,db.eras,db.media,db.archiveSettings,db.memoryRevisions],read) : read()
}
export async function importArchive(data:Archive, mode:'merge'|'replace') {
  validateMemoryRevisions(data.revisions)
  if(data.entries.some(entry => !validDeletionTimestamp(entry.deletedAt))) throw new Error('Archive deletion timestamp is invalid.')
  if (data.profile?.birthDate !== undefined && (typeof data.profile.birthDate !== 'string' || data.profile.birthDate.length !== 10 || calendarDate(data.profile.birthDate) === undefined)) throw new Error('Archive birth date is invalid.')
  await db.transaction('rw',[db.entries,db.people,db.places,db.tags,db.eras,db.media,db.semanticVectors,db.archiveSettings,db.memoryRevisions],async()=>{
    if (mode === 'merge') data = planArchiveMerge(await archive({includeRevisions:true,includeDeleted:true}), data).data
    const localProfile = await db.archiveSettings.get('profile')
    if(mode==='replace') await Promise.all([db.entries.clear(),db.people.clear(),db.places.clear(),db.tags.clear(),db.eras.clear(),db.media.clear(),db.archiveSettings.clear(),db.memoryRevisions.clear()])
    await Promise.all([db.entries.bulkPut(data.entries),db.people.bulkPut(data.people),db.places.bulkPut(data.places),db.tags.bulkPut(data.tags),db.eras.bulkPut(data.eras),data.media?db.media.bulkPut(data.media):Promise.resolve(),db.semanticVectors.clear(),db.memoryRevisions.bulkPut(data.revisions ?? [])])
    if(data.profile && (mode==='replace' || !localProfile?.value.birthDate)) await db.archiveSettings.put({key:'profile',value:data.profile})
    await db.archiveSettings.put({key:'initialized',value:{}})
  })
}
export async function removeEntity(kind:'people'|'places'|'tags'|'eras', id:string){
  await db.transaction('rw',[db.entries,db.people,db.places,db.tags,db.eras,db.media,db.memoryRevisions],async()=>{
    if(kind!=='eras'){
      const field=kind==='people'?'peopleIds':kind==='places'?'placeIds':'tagIds'
      const original=liveMemories(await db.entries.toArray())
      const changed=detachReference(original,field,id)
      const updates=changed.filter(entry=>original.find(item=>item.id===entry.id)?.[field].length!==entry[field].length)
      if(updates.length) {
        for (const entry of updates) {
          const before = original.find(item => item.id === entry.id)!
          const latest = await db.memoryRevisions.where('[memoryId+createdAt]').between([entry.id,Dexie.minKey],[entry.id,Dexie.maxKey]).last()
          entry.updatedAt = revisionTimestamp(before,latest)
          await db.memoryRevisions.add(makeMemoryRevision(before, 'relationship', changedMemoryFields(before, entry), undefined, entry.updatedAt))
        }
        await db.entries.bulkPut(updates)
      }
    }
    if(kind==='places'){
      const associated=await db.media.where('placeId').equals(id).toArray()
      if(associated.length) await db.media.bulkPut(associated.map(item=>({...item,placeId:undefined,placeSuggestionIgnored:false,version:3 as const})))
    }
    await db.table(kind).delete(id)
  })
}
