import 'fake-indexeddb/auto'
import { BlobReader, ZipReader } from '@zip.js/zip.js'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { archive, db, importArchive } from './db'
import { createArchiveManifest, migrateAndValidateArchive, planArchiveMerge } from './archiveFormat'
import { createLifeLineArchive, inspectLifeLineArchive, restoreLifeLineArchive } from './archiveService'
import { decryptLifeLineArchive, encryptLifeLineArchive } from './encryptedArchive'
import { makeMemoryRevision } from './memoryRevisionDomain'
import { deleteMemoryWithHistory, memoryHistory, restoreMemoryRevision, saveMemory } from './memoryRevisionService'
import type { Archive, Entry, MemoryRevision } from './types'

const empty:Archive = {entries:[],people:[],places:[],tags:[],eras:[],media:[]}
const memory = (patch:Partial<Entry> = {}):Entry => ({id:'m',title:'Story',body:'Earlier',entryType:'memory',eventDate:{precision:'range',start:'2010-01-01',end:'2011-01-01',confidence:'guess',display:'Maybe then'},recordTime:'2020-01-01T00:00:00Z',createdAt:'2019-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',importance:2,status:'active',peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[],...patch})
const revision = (entry:Entry, id = 'revision'):MemoryRevision => ({...makeMemoryRevision(entry,'editor',['body']),id,createdAt:'2026-09-26T00:00:00.000Z'})
describe('revision archive preservation', () => {
  beforeEach(async () => {db.close();await db.delete();await db.open()})
  afterAll(() => db.close())
  it('full ZIP and encrypted Replace preserve exact snapshots, orphan history and dates without duplicating media binaries', async () => {
    const original = memory({mediaIds:['photo']})
    await db.entries.add(original)
    await db.media.add({id:'photo',mediaType:'image',filename:'fixture.jpg',mimeType:'image/jpeg',byteSize:3,importedAt:original.createdAt,storageKey:'media/photo',version:3})
    await db.mediaFiles.add({key:'media/photo',blob:new Blob([new Uint8Array([1,2,3])])})
    await saveMemory({...original,body:'Latest story',eventDate:{precision:'approximate',start:'2013-01-01',confidence:'likely'}})
    await db.entries.add(memory({id:'deleted'})); await deleteMemoryWithHistory('deleted')
    // Missing historical references are valid archive data, unlike dangling current relationships.
    const missing = revision(memory({id:'deleted',mediaIds:['gone-media'],peopleIds:['gone-person']}),'missing-history')
    await db.memoryRevisions.add(missing)
    const expected = await db.memoryRevisions.toArray()
    const backup = await createLifeLineArchive()
    expect(backup.manifest).toMatchObject({archiveVersion:3,appSchemaVersion:8,counts:{revisions:3,memories:2,deletedMemories:1,media:1}})
    const reader = new ZipReader(new BlobReader(backup.blob),{useWebWorkers:false})
    expect((await reader.getEntries()).filter(entry => entry.filename.startsWith('media/'))).toHaveLength(1); await reader.close()
    const plain = await inspectLifeLineArchive(backup.blob)
    expect(plain.data.revisions).toEqual(expected)
    const encrypted = await encryptLifeLineArchive(backup.blob,'synthetic revision backup password')
    const inspected = await inspectLifeLineArchive(await decryptLifeLineArchive(encrypted,'synthetic revision backup password'))
    await importArchive(empty,'replace'); expect(await db.memoryRevisions.count()).toBe(0)
    await restoreLifeLineArchive(inspected,'replace')
    expect(await db.memoryRevisions.toArray()).toEqual(expected)
    expect(await db.mediaFiles.count()).toBe(1)
    const prior = (await memoryHistory('m')).revisions[0]
    const restored = await restoreMemoryRevision('m',prior.id)
    expect(restored.entry.eventDate).toEqual(original.eventDate); expect(restored.entry.mediaIds).toEqual(['photo'])
    expect((await memoryHistory('m')).revisions[0].snapshot.body).toBe('Latest story')
  })
  it('Merge remaps memory/entity/media/related IDs inside historical snapshots and resolves colliding revision IDs', () => {
    const localMemory = memory({title:'Local'})
    const incomingMemory = memory({title:'Incoming',peopleIds:['p'],placeIds:['l'],tagIds:['t'],mediaIds:['a','b'],relatedEntryIds:['related']})
    const makeMedia = (id:string,hash:string) => ({id,mediaType:'image' as const,filename:id,mimeType:'image/jpeg',byteSize:1,importedAt:localMemory.createdAt,storageKey:`media/${id}`,contentHash:hash,version:3 as const})
    const local:Archive = {...empty,entries:[localMemory,memory({id:'related',title:'Local related'})],people:[{id:'p',name:'Local person'}],places:[{id:'l',name:'Local place'}],tags:[{id:'t',name:'Local tag',color:'#fff'}],media:[makeMedia('a','a'.repeat(64))],revisions:[revision(localMemory)]}
    const incoming:Archive = {...empty,entries:[incomingMemory,memory({id:'related',title:'Incoming related'})],people:[{id:'p',name:'Incoming person'}],places:[{id:'l',name:'Incoming place'}],tags:[{id:'t',name:'Incoming tag',color:'#fff'}],media:[makeMedia('a','b'.repeat(64)),makeMedia('b','c'.repeat(64))],revisions:[revision({...incomingMemory,body:'Incoming prior',mediaIds:['b','a'],notes:'Prior notes'})]}
    let index = 0
    const plan = planArchiveMerge(local,incoming,() => `new-${++index}`)
    const current = plan.data.entries.find(entry => entry.title === 'Incoming')!
    const old = plan.data.revisions!.find(item => item.snapshot.body === 'Incoming prior')!
    expect(old.id).not.toBe('revision'); expect(old.memoryId).toBe(current.id); expect(old.snapshot.id).toBe(current.id)
    expect(old.snapshot.peopleIds).toEqual(current.peopleIds); expect(old.snapshot.placeIds).toEqual(current.placeIds); expect(old.snapshot.tagIds).toEqual(current.tagIds)
    expect(old.snapshot.mediaIds).toEqual([...current.mediaIds].reverse()); expect(old.snapshot.relatedEntryIds).toEqual(current.relatedEntryIds)
    expect(old.snapshot.notes).toBe('Prior notes'); expect(old.createdAt).toBe(incoming.revisions![0].createdAt)
    expect(plan.data.revisions).toContainEqual(local.revisions![0])
  })
  it('deduplicates identical revisions with different IDs and repeated full Merge with no collisions', async () => {
    const current = memory({body:'Latest'}), prior = revision(memory())
    await importArchive({...empty,entries:[current],revisions:[prior]},'replace')
    const backup = await inspectLifeLineArchive((await createLifeLineArchive()).blob)
    await restoreLifeLineArchive(backup,'merge'); await restoreLifeLineArchive(backup,'merge')
    await importArchive({...empty,entries:[current],revisions:[{...prior,id:'different-id',checkpointKey:'other-session'}]},'merge')
    expect((await memoryHistory(current.id)).total).toBe(1)
  })
  it('Merge of an edited-memory ZIP treats omitted optional JSON fields as unchanged, not a memory ID collision', async () => {
    await db.entries.add(memory())
    await saveMemory({...memory(),body:'Edited'})
    const before = await archive({includeRevisions:true})
    const inspected = await inspectLifeLineArchive((await createLifeLineArchive()).blob)
    await restoreLifeLineArchive(inspected,'merge')
    const after = await archive({includeRevisions:true})
    expect(after.entries).toHaveLength(1);expect(after.revisions).toHaveLength(1)
    expect(after.entries[0].id).toBe(before.entries[0].id)
    expect(after.revisions![0].memoryId).toBe('m')
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)))
  })
  it('missing incoming historical references never bind to unrelated local records or create ghost entities', () => {
    const old = revision(memory({id:'orphan',peopleIds:['p'],placeIds:['l'],tagIds:['t'],mediaIds:['media'],relatedEntryIds:['related']}))
    const local:Archive = {...empty,entries:[memory({id:'orphan'}),memory({id:'related'})],people:[{id:'p',name:'Unrelated local'}],places:[{id:'l',name:'Unrelated local'}],tags:[{id:'t',name:'Unrelated local',color:'#fff'}],media:[{id:'media',mediaType:'image',filename:'local',mimeType:'image/jpeg',byteSize:1,importedAt:'2020-01-01',storageKey:'local',version:3}]}
    let index=0
    const plan = planArchiveMerge(local,{...empty,revisions:[old]},() => `missing-${++index}`)
    const imported = plan.data.revisions![0]
    expect(imported.memoryId).not.toBe('orphan'); expect(imported.snapshot.relatedEntryIds).not.toContain('related')
    expect(imported.snapshot.peopleIds).not.toContain('p'); expect(imported.snapshot.placeIds).not.toContain('l'); expect(imported.snapshot.tagIds).not.toContain('t'); expect(imported.snapshot.mediaIds).not.toContain('media')
    expect(plan.data.people).toEqual(local.people); expect(plan.data.entries).toEqual(local.entries)
  })
  it('accepts real version-1 archives without synthesizing history; rejects malformed/count-mismatched version-2 history', () => {
    const data = {...empty,entries:[memory()]}
    const manifest = createArchiveManifest(data,[])
    const {revisions:_count,...counts} = manifest.counts
    expect(migrateAndValidateArchive({...manifest,archiveVersion:1,appSchemaVersion:7,counts},data).data.revisions).toBeUndefined()
    const invalid = {...data,revisions:[{...revision(memory()),snapshot:{...memory(),mediaIds:[42]}}]}
    expect(() => migrateAndValidateArchive(createArchiveManifest(invalid as unknown as Archive,[]),invalid)).toThrow('revision')
    expect(() => migrateAndValidateArchive({...manifest,counts:{...manifest.counts,revisions:1}},data)).toThrow('count')
  })
  it('a full Merge collision preserves both canonical memories and all associated history', async () => {
    await db.entries.add(memory({body:'Incoming current'})); await db.memoryRevisions.add(revision(memory({body:'Incoming old'})))
    const incoming = await inspectLifeLineArchive((await createLifeLineArchive()).blob)
    await importArchive({...empty,entries:[memory({body:'Local current'})],revisions:[revision(memory({body:'Local old'}))]},'replace')
    await restoreLifeLineArchive(incoming,'merge')
    const merged = await archive({includeRevisions:true})
    const imported = merged.entries.find(entry => entry.body === 'Incoming current')!
    expect(imported.id).not.toBe('m')
    expect(merged.revisions!.find(item => item.snapshot.body === 'Incoming old')).toMatchObject({memoryId:imported.id,snapshot:{id:imported.id}})
    expect(merged.revisions!.find(item => item.snapshot.body === 'Local old')).toMatchObject({memoryId:'m'})
    expect(new Set(merged.revisions!.map(item => item.id)).size).toBe(2)
  })
  it('identical deleted-memory history deduplicates on Merge, while an unrelated incoming memory cannot inherit orphan history', () => {
    const prior = revision(memory({id:'deleted'}))
    const local = {...empty,revisions:[prior]}
    expect(planArchiveMerge(local,local).data.revisions).toHaveLength(1)
    const plan = planArchiveMerge(local,{...empty,entries:[memory({id:'deleted',body:'Unrelated incoming'})]},() => 'new-owner')
    expect(plan.data.entries[0].id).toBe('new-owner')
    expect(plan.data.revisions![0].memoryId).toBe('deleted')
  })
  it('remaps an otherwise identical related-memory chain when an entity collision requires a new target owner', () => {
    const target = memory({id:'target',peopleIds:['p']})
    const linked = memory({id:'linked',relatedEntryIds:['target']})
    const another = memory({id:'another',relatedEntryIds:['linked']})
    const base = {...empty,entries:[target,linked,another]}
    let next = 0
    const plan = planArchiveMerge({...base,people:[{id:'p',name:'Local'}]},{...base,people:[{id:'p',name:'Incoming'}],revisions:[revision(another)]},() => `remapped-${++next}`)
    const importedTarget = plan.data.entries.find(entry => entry.peopleIds.includes('remapped-1'))!
    const importedLinked = plan.data.entries.find(entry => entry.relatedEntryIds.includes(importedTarget.id))!
    const importedAnother = plan.data.entries.find(entry => entry.relatedEntryIds.includes(importedLinked.id))!
    expect(importedAnother.id).not.toBe('another')
    expect(plan.data.revisions![0].memoryId).toBe(importedAnother.id)
    expect(plan.data.revisions![0].snapshot.relatedEntryIds).toEqual([importedLinked.id])
  })
})
