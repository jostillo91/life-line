import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { archive, db, importArchive, initializeArchive, removeEntity } from './db'
import { deleteMemoryWithHistory, memoryHistory, purgeDeletedMemories, restoreDeletedMemory, saveMemory, undoMemoryDeletion } from './memoryRevisionService'
import { deletedMemories } from './recoveryDomain'
import { RecoveryList, RecoveryPreview } from './RecoveryCenter'
import { keywordSearch, rankSemanticResults } from './semanticSearch'
import { SemanticSearchService } from './semanticIndex'
import { mockEmbeddingProvider } from './embeddingProvider'
import { AskLifeLineService } from './askService'
import { deriveAskHints, isEvidenceCurrent, localEvidence, selectAskEvidence } from './askDomain'
import { filterTimeline } from './timelineLayout'
import { deriveLifeMapPoints } from './lifeMapDomain'
import { referencesFor } from './domain'
import { deleteMediaFile, readMediaFile, saveMediaFile } from './mediaStorage'
import { createLifeLineArchive, inspectLifeLineArchive, restoreLifeLineArchive } from './archiveService'
import { decryptLifeLineArchive, encryptLifeLineArchive } from './encryptedArchive'
import { createArchiveManifest, migrateAndValidateArchive, planArchiveMerge } from './archiveFormat'
import type { Archive, Entry } from './types'

const empty:Archive={entries:[],people:[],places:[],tags:[],eras:[],media:[]}
const memory=(patch:Partial<Entry>={}):Entry=>({id:'memory',title:'School memory',body:'A school story',entryType:'memory',eventDate:{precision:'year',start:'2001',confidence:'likely'},recordTime:'2020-01-01T00:00:00.000Z',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',importance:1,status:'active',peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[],...patch})
const target=(entry:Entry)=>({id:entry.id,deletedAt:entry.deletedAt!})
beforeEach(async()=>{db.close();await db.delete();await db.open()})
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals()})

describe('recoverable canonical memory deletion',()=>{
  it('does not reseed starter memories after Empty Trash or restoring an empty archive',async()=>{
    await initializeArchive({...empty,entries:[memory()]})
    const deleted=await deleteMemoryWithHistory('memory')
    await purgeDeletedMemories([target(deleted!.entry)],'DELETE 1')
    db.close();await db.open()
    await initializeArchive({...empty,entries:[memory({id:'demo'})]})
    expect(await db.entries.count()).toBe(0)
    await importArchive(empty,'replace')
    await initializeArchive({...empty,entries:[memory({id:'demo'})]})
    expect(await db.entries.count()).toBe(0)
  })
  it('soft deletes without changing content, identity, timestamps, dates or attachment references',async()=>{
    const original=memory({mediaIds:['photo'],peopleIds:['person'],notes:'Keep this'})
    await db.entries.add(original)
    const deleted=await deleteMemoryWithHistory(original.id)
    expect(deleted!.entry).toEqual({...original,deletedAt:expect.any(String)})
    expect(await db.entries.get(original.id)).toEqual(deleted!.entry)
    expect((await archive()).entries).toHaveLength(0)
    expect((await archive({includeDeleted:true})).entries).toHaveLength(1)
    expect((await memoryHistory(original.id)).revisions[0].snapshot).toEqual(original)
  })
  it('keeps deleted memories across restart and orders newest deletion first',async()=>{
    await db.entries.bulkAdd([memory({id:'older',deletedAt:'2026-01-01T00:00:00.000Z'}),memory({id:'newer',deletedAt:'2026-02-01T00:00:00.000Z'})])
    db.close();await db.open()
    expect(deletedMemories(await db.entries.toArray()).map(item=>item.id)).toEqual(['newer','older'])
    expect((await archive()).entries).toEqual([])
  })
  it('restores original ID/createdAt/current content and all history without any network call',async()=>{
    vi.stubGlobal('navigator',{onLine:false});const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Offline'))
    const original=memory();await db.entries.add(original);await saveMemory({...original,body:'Latest story'})
    await deleteMemoryWithHistory(original.id)
    const before=await memoryHistory(original.id)
    const restored=await restoreDeletedMemory(original.id)
    expect(restored.entry).toMatchObject({id:original.id,createdAt:original.createdAt,recordTime:original.recordTime,body:'Latest story'})
    expect(restored.entry.deletedAt).toBeUndefined();expect(await memoryHistory(original.id)).toEqual(before)
    expect((await archive()).entries).toHaveLength(1);expect(fetcher).not.toHaveBeenCalled()
  })
  it('retains immediate Undo while preserving related links and revision history',async()=>{
    const original=memory();await db.entries.bulkAdd([original,memory({id:'related',relatedEntryIds:[original.id]})])
    const deleted=await deleteMemoryWithHistory(original.id)
    expect((await db.entries.get('related'))!.relatedEntryIds).toEqual([original.id])
    await undoMemoryDeletion(deleted!)
    expect((await db.entries.get(original.id))!.deletedAt).toBeUndefined()
    expect((await memoryHistory(original.id)).total).toBe(1)
    expect((await db.entries.get('related'))!.relatedEntryIds).toEqual([original.id])
  })
  it('rejects stale Undo after re-deletion or permanent deletion',async()=>{
    await db.entries.add(memory());const first=await deleteMemoryWithHistory('memory')
    await undoMemoryDeletion(first!);const second=await deleteMemoryWithHistory('memory')
    await expect(undoMemoryDeletion(first!)).rejects.toThrow('changed')
    await purgeDeletedMemories([target(second!.entry)],'DELETE 1')
    await expect(undoMemoryDeletion(second!)).rejects.toThrow('no longer available')
    expect(await db.entries.get('memory')).toBeUndefined()
  })
  it('filters missing entities/files on recovery without recreating them or rewriting original history',async()=>{
    const original=memory({peopleIds:['p'],placeIds:['l'],tagIds:['t'],mediaIds:['gone-media'],relatedEntryIds:['gone-memory']})
    await db.entries.add(original);await db.people.add({id:'p',name:'Person'});await deleteMemoryWithHistory(original.id)
    await removeEntity('people','p')
    expect((await db.entries.get(original.id))!.peopleIds).toEqual(['p'])
    const restored=await restoreDeletedMemory(original.id)
    expect(restored.entry).toMatchObject({peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[]})
    expect(restored.warnings).toHaveLength(5)
    expect((await memoryHistory(original.id)).revisions[0].snapshot.peopleIds).toEqual(['p'])
    expect(await db.people.count()).toBe(0)
  })
  it('keeps relationships to other recoverable memories, becoming usable after both restore',async()=>{
    await db.entries.bulkAdd([memory({id:'a',relatedEntryIds:['b']}),memory({id:'b',relatedEntryIds:['a']})])
    await deleteMemoryWithHistory('a');await deleteMemoryWithHistory('b')
    expect((await restoreDeletedMemory('a')).entry.relatedEntryIds).toEqual(['b'])
    await restoreDeletedMemory('b');expect((await archive()).entries).toHaveLength(2)
  })
  it('prevents normal editing of trash and stale editors recreating permanently removed memories',async()=>{
    const original=memory();await db.entries.add(original);const deleted=await deleteMemoryWithHistory(original.id)
    await expect(saveMemory({...original,body:'Stale autosave'})).rejects.toThrow('Recovery Center')
    await purgeDeletedMemories([target(deleted!.entry)],'DELETE 1')
    await expect(saveMemory(original,{requireExisting:true})).rejects.toThrow('stale editor')
  })
  it('needs no database version change and treats existing records without deletedAt as live',async()=>{
    await db.entries.add(memory());db.close();await db.open()
    expect(db.verno).toBe(8);expect((await archive()).entries).toEqual([memory()])
  })
})

describe('derived views, read-only recovery and semantic isolation',()=>{
  it('excludes trash from Timeline, keyword/semantic results, entities, map and Ask even with a complete archive',async()=>{
    const entry=memory({deletedAt:'2026-01-01T00:00:00.000Z',peopleIds:['p'],placeIds:['l']})
    const data={...empty,entries:[entry],people:[{id:'p',name:'Person'}],places:[{id:'l',name:'Place',latitude:1,longitude:2}]}
    expect(filterTimeline(data,{})).toEqual([]);expect(keywordSearch(data,'school')).toEqual([])
    expect(rankSemanticResults(data,'school',[1],[{memoryId:entry.id,sourceType:'memory',model:'m',dimension:1,indexVersion:1,fingerprint:'x',generatedAt:'x',vector:[1]}])).toEqual([])
    expect(referencesFor(data.entries,'peopleIds','p')).toEqual([])
    expect(deriveLifeMapPoints(data,{kind:'all'},{places:true,memories:true,unassigned:false})[0]).toMatchObject({memories:[]})
    expect((await new AskLifeLineService(undefined,undefined).retrieve(data,'school',{},new AbortController().signal)).evidence).toEqual([])
    const evidence=selectAskEvidence({...data,entries:[{...entry,deletedAt:undefined}]},'school',deriveAskHints('school',data))
    expect(localEvidence(data,evidence)).toEqual([]);expect(isEvidenceCurrent(data,evidence[0])).toBe(false)
  })
  it('removes a derived vector on deletion and restores as pending reindex without provider calls',async()=>{
    await db.entries.add(memory())
    const provider={...mockEmbeddingProvider},service=new SemanticSearchService(provider),info=await provider.info()
    await service.indexPending(await archive(),info,new AbortController().signal)
    expect(await db.semanticVectors.count()).toBe(1)
    await deleteMemoryWithHistory('memory');expect(await db.semanticVectors.count()).toBe(0)
    expect((await service.plan(await archive({includeDeleted:true}),info)).status.total).toBe(0)
    const embed=vi.spyOn(provider,'embedDocuments');await restoreDeletedMemory('memory')
    expect((await service.plan(await archive(),info)).status).toMatchObject({indexed:0,pending:1,total:1})
    expect(embed).not.toHaveBeenCalled()
  })
  it('does not write an in-flight embedding after its memory was deleted',async()=>{
    await db.entries.add(memory());const provider={...mockEmbeddingProvider},service=new SemanticSearchService(provider),info=await provider.info()
    const original=provider.embedDocuments.bind(provider)
    vi.spyOn(provider,'embedDocuments').mockImplementation(async(text,signal)=>{const result=await original(text,signal);await deleteMemoryWithHistory('memory');return result})
    await service.indexPending(await archive(),info,new AbortController().signal)
    expect(await db.semanticVectors.count()).toBe(0)
  })
  it('renders read-only content and metadata without normal editing/AI controls',()=>{
    const entry=memory({deletedAt:'2026-01-01T00:00:00.000Z'})
    const html=renderToStaticMarkup(<RecoveryPreview entry={entry} data={empty}/>)
    expect(html).toContain('READ-ONLY');expect(html).toContain(entry.body);expect(html).not.toContain('textarea');expect(html).not.toContain('Edit memory');expect(html).not.toContain('Memory Assistant')
    const list=renderToStaticMarkup(<RecoveryList entries={[entry]} onSelect={()=>{}}/>)
    expect(list).toContain('Preview deleted memory: School memory');expect(list).toContain('2001');expect(list).toContain('Deleted');expect(list).toContain('0 attachment')
  })
})

describe('permanent cleanup and media preservation',()=>{
  it('requires typed confirmation and refuses live targets before changing anything',async()=>{
    await db.entries.bulkAdd([memory(),memory({id:'live'})]);const deleted=await deleteMemoryWithHistory('memory')
    await expect(purgeDeletedMemories([target(deleted!.entry)],'DELETE')).rejects.toThrow('DELETE 1')
    await expect(purgeDeletedMemories([target(memory({id:'live',deletedAt:'fake'}))],'DELETE 1')).rejects.toThrow('changed')
    expect(await db.entries.count()).toBe(2);expect(await db.memoryRevisions.count()).toBe(1)
  })
  it('removes the memory and all owned revisions, cleans related links, and keeps media bytes',async()=>{
    const media=await saveMediaFile(new File(['original'],'kept.txt',{type:'text/plain'}))
    await db.entries.bulkAdd([memory({mediaIds:[media.id]}),memory({id:'related',relatedEntryIds:['memory']})])
    await saveMemory({...memory({mediaIds:[media.id]}),body:'Edited'})
    const deleted=await deleteMemoryWithHistory('memory');expect(await db.mediaFiles.count()).toBe(1)
    expect((await archive()).entries.every(entry=>!entry.mediaIds.includes(media.id))).toBe(true)
    await purgeDeletedMemories([target(deleted!.entry)],'DELETE 1')
    expect(await db.entries.get('memory')).toBeUndefined();expect((await memoryHistory('memory')).total).toBe(0)
    expect((await db.entries.get('related'))!.relatedEntryIds).toEqual([])
    expect(await (await readMediaFile(media))!.text()).toBe('original');expect(await db.media.count()).toBe(1)
  })
  it('allows independent deletion of unattached media while its deleted memory remains recoverable',async()=>{
    const media=await saveMediaFile(new File(['bytes'],'orphan.txt',{type:'text/plain'}))
    await db.entries.add(memory({mediaIds:[media.id]}));await deleteMemoryWithHistory('memory')
    await deleteMediaFile(media)
    const restored=await restoreDeletedMemory('memory');expect(restored.entry.mediaIds).toEqual([]);expect(restored.warnings[0]).toContain('Media')
  })
  it('empties the reviewed Trash set atomically, never deleting live memories or other owners history',async()=>{
    await db.entries.bulkAdd([memory({id:'a'}),memory({id:'b'}),memory({id:'live'})])
    await deleteMemoryWithHistory('a');await deleteMemoryWithHistory('b');await saveMemory({...memory({id:'live'}),body:'Changed'})
    const targets=deletedMemories(await db.entries.toArray()).map(target)
    expect(await purgeDeletedMemories(targets,'DELETE 2')).toBe(2)
    expect((await db.entries.toArray()).map(entry=>entry.id)).toEqual(['live']);expect((await db.memoryRevisions.toArray()).every(item=>item.memoryId==='live')).toBe(true)
  })
  it('rolls back all cleanup if any write fails',async()=>{
    await db.entries.add(memory());const deleted=await deleteMemoryWithHistory('memory')
    vi.spyOn(db.entries,'delete').mockRejectedValueOnce(Error('Disk error'))
    await expect(purgeDeletedMemories([target(deleted!.entry)],'DELETE 1')).rejects.toThrow('Disk error')
    expect((await db.entries.get('memory'))!.deletedAt).toBeDefined();expect((await memoryHistory('memory')).total).toBe(1)
  })
})

describe('complete archive deletion-state preservation',()=>{
  it('preserves deleted state, history and missing references through offline ZIP/encryption/Replace and JSON',async()=>{
    vi.stubGlobal('navigator',{onLine:false});const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Offline'))
    await db.entries.add(memory({peopleIds:['gone-person']}));await deleteMemoryWithHistory('memory')
    const source=await archive({includeDeleted:true,includeRevisions:true})
    const json=JSON.parse(JSON.stringify(source)) as Archive
    await importArchive(json,'replace');expect(await archive({includeDeleted:true,includeRevisions:true})).toEqual(source)
    const zip=await createLifeLineArchive();expect(zip.manifest).toMatchObject({archiveVersion:3,counts:{memories:1,deletedMemories:1,revisions:1}})
    const encrypted=await encryptLifeLineArchive(zip.blob,'synthetic recovery backup')
    const inspected=await inspectLifeLineArchive(await decryptLifeLineArchive(encrypted,'synthetic recovery backup'))
    await importArchive(empty,'replace');await restoreLifeLineArchive(inspected,'replace')
    expect(await archive({includeDeleted:true,includeRevisions:true})).toEqual(source);expect((await archive()).entries).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('Merge never overwrites a live local memory with a deleted incoming copy or resurrects local trash',async()=>{
    const live=memory(),deleted={...live,deletedAt:'2026-01-01T00:00:00.000Z'}
    let id=0
    const merge=planArchiveMerge({...empty,entries:[live]},{...empty,entries:[deleted]},()=>`new-${++id}`)
    expect(merge.data.entries.find(entry=>entry.id===live.id)).toEqual(live)
    expect(merge.data.entries.find(entry=>entry.deletedAt)!.id).not.toBe(live.id)
    const reverse=planArchiveMerge({...empty,entries:[deleted]},{...empty,entries:[live]},()=>`new-${++id}`)
    expect(reverse.data.entries.find(entry=>entry.id===deleted.id)).toEqual(deleted)
    expect(reverse.data.entries.find(entry=>!entry.deletedAt)!.id).not.toBe(deleted.id)
    await db.entries.add(live);await importArchive({...empty,entries:[deleted]},'merge')
    expect((await archive()).entries).toEqual([live]);expect(deletedMemories((await archive({includeDeleted:true})).entries)).toHaveLength(1)
  })
  it('remaps missing incoming trash references rather than binding them to unrelated local entities',()=>{
    let id=0;const deleted=memory({id:'trash',deletedAt:'2026-01-01T00:00:00.000Z',peopleIds:['p']})
    const plan=planArchiveMerge({...empty,people:[{id:'p',name:'Unrelated local person'}]},{...empty,entries:[deleted]},()=>`missing-${++id}`)
    expect(plan.data.entries[0].peopleIds).not.toContain('p')
  })
  it('rejects invalid deletion metadata and accepts legacy v1/v2 backups without marking any memory deleted',async()=>{
    for(const value of ['invalid',null,123,'2026-01-01']) {
      const source={...empty,entries:[memory({deletedAt:value as string})]}
      expect(()=>migrateAndValidateArchive(createArchiveManifest(source,[]),source)).toThrow('deletion timestamp')
      await expect(importArchive(source,'replace')).rejects.toThrow('deletion timestamp')
    }
    for(const version of [1,2]) {
      const source={...empty,entries:[memory()]};const manifest={...createArchiveManifest(source,[]),archiveVersion:version}
      expect(migrateAndValidateArchive(manifest,source).data.entries[0].deletedAt).toBeUndefined()
    }
  })
})
