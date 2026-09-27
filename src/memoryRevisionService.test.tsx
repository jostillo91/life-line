import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archive, db, importArchive, removeEntity } from './db'
import { changedMemoryFields, bodyLineDiff, makeMemoryRevision, memorySnapshot, prepareRevisionRestore, validateMemoryRevisions } from './memoryRevisionDomain'
import { deleteMemoryWithHistory, editorCheckpointKey, memoryHistory, restoreMemoryRevision, saveMemory, undoMemoryDeletion } from './memoryRevisionService'
import { RevisionComparison } from './MemoryHistoryView'
import { keywordSearch, buildSearchDocument, rankSemanticResults } from './semanticSearch'
import { deriveAskHints, selectAskEvidence } from './askDomain'
import { sorted } from './date'
import type { Archive, Entry } from './types'

export function memory(patch:Partial<Entry> = {}):Entry {
  return {id:'memory',title:'My story',body:'Earlier story',entryType:'story',eventDate:{precision:'season',start:'2012-01-01',season:'Summer',confidence:'likely',display:'That summer'},recordTime:'2020-02-01T00:00:00.000Z',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-02-01T00:00:00.000Z',importance:3,status:'active',peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[],...patch}
}
const empty:Archive = {entries:[],people:[],places:[],tags:[],eras:[],media:[]}
describe('durable memory history', () => {
  beforeEach(async () => { db.close(); await db.delete(); await db.open() })
  afterAll(() => db.close())
  it('adds only a first meaningful baseline, not migration/new memories/unchanged timestamps', async () => {
    const entry = memory()
    await saveMemory(entry)
    expect(await db.memoryRevisions.count()).toBe(0)
    await saveMemory({...entry,updatedAt:new Date().toISOString()})
    expect(await db.memoryRevisions.count()).toBe(0)
    await saveMemory({...entry,body:'Later story'})
    const [revision] = (await memoryHistory(entry.id)).revisions
    expect(revision.snapshot.body).toBe('Earlier story')
    expect(revision.changedFields).toEqual(['body'])
    expect((await db.entries.get(entry.id))?.body).toBe('Later story')
  })
  it('coalesces 100 autosaves and close into one session checkpoint, creates a new long-session window', async () => {
    const entry = memory(); await db.entries.add(entry)
    const key = editorCheckpointKey('session',1000,1000)
    for (let index = 0; index < 100; index++) await saveMemory({...entry,body:`Typing ${index}`},{checkpointKey:key})
    await saveMemory({...entry,body:'Typing 99'},{checkpointKey:key})
    expect((await memoryHistory(entry.id)).total).toBe(1)
    expect((await memoryHistory(entry.id)).revisions[0].snapshot.body).toBe('Earlier story')
    await saveMemory({...entry,body:'Long session'}, {checkpointKey:editorCheckpointKey('session',1000,301000)})
    expect((await memoryHistory(entry.id)).total).toBe(2)
    expect((await memoryHistory(entry.id)).revisions[0].snapshot.body).toBe('Typing 99')
    await saveMemory({...entry,body:'New session'},{checkpointKey:editorCheckpointKey('another',1000,1000)})
    expect((await memoryHistory(entry.id)).total).toBe(3)
  })
  it('detects complete date metadata, all canonical fields and media ordering; ignores key order and timestamps', () => {
    const before = memory({notes:'notes',peopleIds:['person'],mediaIds:['a','b']})
    expect(changedMemoryFields(before,{...before,updatedAt:'other',createdAt:'other',eventDate:{confidence:'likely',season:'Summer',start:'2012-01-01',precision:'season',display:'That summer'}})).toEqual([])
    expect(changedMemoryFields(before,{...before,mediaIds:['b','a'],notes:'updated',importance:5,status:'archived',relatedEntryIds:['related'],peopleIds:[],placeIds:['place'],tagIds:['tag'],title:'Title',entryType:'journal',body:'Body',eventDate:{precision:'approximate',start:'2013-01-01',confidence:'guess'}})).toHaveLength(12)
  })
  it('preserves full date metadata before movement and starts a fresh editor checkpoint after a discrete operation', async () => {
    const before = memory(); await db.entries.add(before)
    const edited = await saveMemory({...before,body:'Typed'},{checkpointKey:'session:0'})
    const moved = await saveMemory({...edited,eventDate:{precision:'approximate',start:'2013-01-01',confidence:'guess',display:'Maybe 2013'}},{source:'dateMove'})
    expect((await memoryHistory(before.id)).revisions[0]).toMatchObject({source:'dateMove',snapshot:{eventDate:before.eventDate,body:'Typed'}})
    await saveMemory({...moved,body:'Typed again'},{checkpointKey:'session:0'})
    expect((await memoryHistory(before.id)).total).toBe(3)
  })
  it('snapshots relationships and attachment order without binary duplication', async () => {
    const before = memory({peopleIds:['p'],placeIds:['l'],tagIds:['t'],mediaIds:['a','b'],relatedEntryIds:['r'],notes:'Keep notes'})
    await db.entries.add(before)
    await saveMemory({...before,mediaIds:['b','a'],peopleIds:[],placeIds:[],tagIds:[],relatedEntryIds:[]},{source:'media'})
    const revision = (await memoryHistory(before.id)).revisions[0]
    expect(revision.snapshot).toEqual(before)
    expect(await db.mediaFiles.count()).toBe(0)
    expect(revision.changedFields).toContain('mediaIds')
  })
  it('preview is read-only, names unavailable references, renders readable escaped body differences', async () => {
    const historical = memory({body:'<script>old</script>\nShared',peopleIds:['missing']})
    const current = memory({body:'New\nShared'})
    await db.entries.add(current)
    const before = structuredClone(historical)
    const markup = renderToStaticMarkup(<RevisionComparison historical={historical} current={current} capturedAt={current.updatedAt} data={{...empty,entries:[current]}}/>)
    expect(markup).toContain('Current version'); expect(markup).toContain('Version preserved'); expect(markup).toContain('Unavailable (missing)')
    expect(markup).toContain('diff-removed'); expect(markup).toContain('diff-added'); expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('<textarea'); expect(markup).not.toContain('<input')
    expect(historical).toEqual(before); expect(await db.entries.get(current.id)).toEqual(current)
  })
  it('restores prior content atomically, preserving current state, all history and identity; restoring back works', async () => {
    const original = memory(); await db.entries.add(original)
    await saveMemory({...original,body:'Second'})
    await saveMemory({...original,body:'Third'})
    const prior = await memoryHistory(original.id)
    const baseline = prior.revisions.find(revision => revision.snapshot.body === 'Earlier story')!
    const result = await restoreMemoryRevision(original.id,baseline.id)
    expect(result.entry).toMatchObject({id:original.id,createdAt:original.createdAt,recordTime:original.recordTime,body:original.body})
    expect(Date.parse(result.entry.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt))
    const history = await memoryHistory(original.id)
    expect(history.total).toBe(3)
    expect(history.revisions[0]).toMatchObject({source:'restore',snapshot:{body:'Third'}})
    expect(history.revisions.map(revision => revision.id)).toEqual(expect.arrayContaining(prior.revisions.map(revision => revision.id)))
    await restoreMemoryRevision(original.id,history.revisions[0].id)
    expect((await db.entries.get(original.id))?.body).toBe('Third')
    expect((await memoryHistory(original.id)).total).toBe(4)
    await restoreMemoryRevision(original.id,history.revisions[0].id)
    expect((await memoryHistory(original.id)).total).toBe(4)
  })
  it('omits missing media/entities/related memories on restore and reports all missing categories, never recreating records', async () => {
    const original = memory({peopleIds:['p','gone-person'],placeIds:['gone-place'],tagIds:['gone-tag'],mediaIds:['b','gone-media','a'],relatedEntryIds:['gone-memory']})
    await db.entries.add(original); await db.people.add({id:'p',name:'Present'})
    for (const id of ['a','b']) await db.media.add({id,mediaType:'image',filename:id,mimeType:'image/jpeg',byteSize:1,importedAt:original.createdAt,storageKey:`media/${id}`,version:3})
    await saveMemory({...original,body:'New',peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[]})
    const baseline = (await memoryHistory(original.id)).revisions[0]
    const result = await restoreMemoryRevision(original.id,baseline.id)
    expect(result.warnings).toHaveLength(5)
    expect(result.entry).toMatchObject({peopleIds:['p'],placeIds:[],tagIds:[],mediaIds:['b','a'],relatedEntryIds:[]})
    expect(await db.media.count()).toBe(2); expect(await db.mediaFiles.count()).toBe(0); expect(await db.people.count()).toBe(1); expect(await db.places.count()).toBe(0)
    expect((await db.memoryRevisions.get(baseline.id))?.snapshot).toEqual(original)
  })
  it('accepted AI changes get a checkpoint; pending/rejected proposals and read-only previews do not write', async () => {
    const original = memory(); await db.entries.add(original)
    const proposal = {...original,body:'Assistant proposal'}
    // A proposal is not a canonical save, exactly as in MemoryAssistant.
    memorySnapshot(proposal); prepareRevisionRestore(original,proposal,{...empty,entries:[original]})
    expect(await db.memoryRevisions.count()).toBe(0)
    await saveMemory(proposal,{source:'assistantAccepted'})
    expect((await memoryHistory(original.id)).revisions[0]).toMatchObject({source:'assistantAccepted',snapshot:{body:original.body}})
  })
  it('entity deletion checkpoints detached relationships; soft deletion retains final history and links through short-term undo', async () => {
    const original = memory({peopleIds:['p']}); await db.entries.add(original); await db.people.add({id:'p',name:'Person'})
    await removeEntity('people','p')
    expect((await memoryHistory(original.id)).revisions[0]).toMatchObject({source:'relationship',snapshot:{peopleIds:['p']}})
    await db.entries.add(memory({id:'related',relatedEntryIds:[original.id]}))
    const deleted = await deleteMemoryWithHistory(original.id)
    expect((await db.entries.get(original.id))?.deletedAt).toBeDefined()
    expect((await archive()).entries.some(entry=>entry.id===original.id)).toBe(false)
    expect((await db.entries.get('related'))?.relatedEntryIds).toEqual([original.id])
    expect((await memoryHistory(original.id)).total).toBe(2)
    await undoMemoryDeletion(deleted!)
    expect((await db.entries.get('related'))?.relatedEntryIds).toEqual([original.id])
    expect((await memoryHistory(original.id)).total).toBe(2)
  })
  it('queries paginated newest-first history for one memory and persists across database reopen', async () => {
    const original = memory(); await db.entries.add(original)
    for (let i = 0; i < 45; i++) await saveMemory({...original,body:`Version ${i}`})
    await db.memoryRevisions.add(makeMemoryRevision(memory({id:'other'}),'editor',['body']))
    db.close(); await db.open()
    const page = await memoryHistory(original.id,20,20)
    expect(page.total).toBe(45); expect(page.revisions).toHaveLength(20)
    expect(page.revisions.every(revision => revision.memoryId === original.id)).toBe(true)
    expect(page.revisions[0].createdAt > page.revisions[1].createdAt).toBe(true)
  })
  it('ordinary archive loads do not query history, and Timeline/search/semantic/Ask use only current content', async () => {
    const original = memory({body:'historicaluniquetoken'}); await db.entries.add(original)
    await saveMemory({...original,body:'Current only'})
    const spy = vi.spyOn(db.memoryRevisions,'toArray')
    const normal = await archive(); expect(spy).not.toHaveBeenCalled(); expect(normal.revisions).toBeUndefined(); spy.mockRestore()
    const full = await archive({includeRevisions:true})
    expect(keywordSearch(full,'historicaluniquetoken')).toEqual([])
    expect(buildSearchDocument(full.entries[0],full).text).not.toContain('historicaluniquetoken')
    expect(selectAskEvidence(full,'historicaluniquetoken',deriveAskHints('historicaluniquetoken',full))).toEqual([])
    expect(rankSemanticResults(full,'Current',[1],[],{})).toEqual([])
    expect(sorted(full.entries)).toHaveLength(1)
  })
  it('JSON exports roundtrip history and malformed revisions cannot partially Replace canonical data', async () => {
    const original = memory(); await db.entries.add(original); await saveMemory({...original,body:'Changed'})
    const json = JSON.parse(JSON.stringify(await archive({includeRevisions:true})))
    await importArchive(json,'replace'); expect((await memoryHistory(original.id)).total).toBe(1)
    await importArchive(json,'merge'); expect((await memoryHistory(original.id)).total).toBe(1)
    const invalid = {...json,revisions:[{...json.revisions[0],snapshot:{...json.revisions[0].snapshot,body:4}}]}
    await expect(importArchive(invalid,'replace')).rejects.toThrow('revision')
    expect((await db.entries.get(original.id))?.body).toBe('Changed')
    expect(() => validateMemoryRevisions([{...json.revisions[0],snapshot:{...json.revisions[0].snapshot,uiState:{}}}])).toThrow('unsupported')
  })
  it('upgrade from schema 7 only adds an empty history table and preserves canonical values/profile/binaries', async () => {
    db.close(); await db.delete()
    const old = new Dexie('life-line-diary')
    old.version(7).stores({entries:'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds',people:'id,name',places:'id,name',tags:'id,name',eras:'id,name',media:'id,mediaType,filename,importedAt,contentHash,captureDate,placeId',mediaFiles:'key',restoreFiles:'key',semanticVectors:'memoryId,model,indexVersion',semanticSettings:'key',archiveSettings:'key'})
    const original = memory(); await old.open(); await old.table('entries').put(original); await old.table('archiveSettings').put({key:'profile',value:{birthDate:'1990-01-01'}}); await old.table('mediaFiles').put({key:'kept',blob:new Blob(['bytes'])}); old.close()
    await db.open(); expect(db.verno).toBe(8); expect(await db.entries.get(original.id)).toEqual(original); expect(await db.memoryRevisions.count()).toBe(0); expect((await archive()).profile?.birthDate).toBe('1990-01-01'); expect(await db.mediaFiles.count()).toBe(1)
  })
  it('rejects cross-memory restore and bounds large body diffs', async () => {
    const original = memory(); await db.entries.add(original)
    const other = makeMemoryRevision(memory({id:'other'}),'editor',[]); await db.memoryRevisions.add(other)
    await expect(restoreMemoryRevision(original.id,other.id)).rejects.toThrow('no longer available')
    expect(bodyLineDiff('a\nsame','b\nsame')).toEqual([{kind:'removed',text:'a'},{kind:'added',text:'b'},{kind:'same',text:'same'}])
    expect(bodyLineDiff('large'.repeat(30000),'new')).toBeNull()
  })
})
