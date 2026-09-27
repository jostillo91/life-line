import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archive, db } from './db'
import { dateLabel } from './date'
import { calendarDate, eventSpan } from './timelineLayout'
import { memoryHistory, saveMemory } from './memoryRevisionService'
import { buildSearchDocument, keywordSearch } from './semanticSearch'
import { capturedMemory, captureDateError, captureDraftKey, captureSubmission, discardCaptureDraft, fastCaptureDate, hasCaptureContent, newCaptureDraft, readCaptureDraft, shouldOpenCapture, writeCaptureDraft, type CaptureDraftStorage } from './quickCaptureDomain'
import { importCaptureFiles } from './quickCaptureMedia'
import { saveCaptureMemory } from './quickCaptureService'
import { CaptureSaved, QuickCaptureDraftBanner, QuickCaptureView } from './QuickCaptureView'
import { MemoryDetailView } from './MemoryDetailView'
import { AttachmentPanel } from './AttachmentPanel'
import { UnsortedMemoriesView } from './UnsortedMemoriesView'
import type { Media } from './types'

const draft = () => newCaptureDraft(new Date('2026-09-26T17:00:00.000Z'),'capture-test')
const noop = () => {}
function storage():CaptureDraftStorage {
  const values = new Map<string,string>()
  return {getItem:key => values.get(key) ?? null,setItem:(key,value) => {values.set(key,value)},removeItem:key => {values.delete(key)}}
}
const media = (id:string):Media => ({id,mediaType:'image',filename:`${id}.png`,mimeType:'image/png',byteSize:10,importedAt:'2026-09-26T17:00:00.000Z',storageKey:id,version:3})

describe('Quick Capture local memory and recovery', () => {
  beforeEach(async () => {db.close();await db.delete();await db.open()})
  afterAll(() => db.close())
  it('opening creates neither an empty memory nor a revision', async () => {
    const value=draft(),onSave=vi.fn(saveCaptureMemory)
    const html=renderToStaticMarkup(<QuickCaptureView draftKey="test" initialDraft={value} onSave={onSave} onClose={noop} onOpenEditor={noop} onDraftChange={noop}/>)
    expect(html).toContain('role="dialog"');expect(html).toContain('id="capture-story"')
    expect(html).toContain('<details class="capture-options">');expect(html).not.toContain('Memory Assistant')
    expect(onSave).not.toHaveBeenCalled();expect(await db.entries.count()).toBe(0);expect(await db.memoryRevisions.count()).toBe(0)
    expect(hasCaptureContent(value)).toBe(false);expect(() => capturedMemory(value)).toThrow('Write a thought')
  })
  it('saves body-only text as a canonical unknown-date Memory with a safe title', async () => {
    const value={...draft(),body:'The smell of rain at the old station.'},result=await saveCaptureMemory(value)
    expect(result.entry).toMatchObject({id:value.id,title:'Untitled memory',body:value.body,entryType:'memory',eventDate:{precision:'unknown',confidence:'unknown'},createdAt:value.createdAt,recordTime:value.recordTime})
    expect(eventSpan(result.entry.eventDate)).toBeUndefined();expect((await archive()).entries).toEqual([result.entry])
    expect(result.warnings).toEqual([]);expect(await db.memoryRevisions.count()).toBe(0)
    const html=renderToStaticMarkup(<UnsortedMemoriesView entries={(await archive()).entries.filter(entry => ['unknown','age'].includes(entry.eventDate.precision))} onOpenMemory={noop} onDragMemory={noop}/>)
    expect(html).toContain('Untitled memory');expect(html).toContain(value.body);expect(html).toContain('UNDATED')
  })
  it('permits an explicit title-only capture even when it matches the placeholder', async () => {
    expect((await saveCaptureMemory({...draft(),title:' Untitled memory '})).entry.title).toBe('Untitled memory')
  })
  it('keeps record/creation time independent of the selected calendar date', async () => {
    const value={...draft(),title:' A moment ',body:'Story',eventDate:fastCaptureDate('yesterday',new Date(2011,0,1,9))}, {entry}=await saveCaptureMemory(value)
    expect(entry.eventDate.start).toBe('2010-12-31');expect(entry.title).toBe('A moment')
    expect(entry.recordTime).toBe(value.recordTime);expect(entry.createdAt).toBe(value.createdAt)
  })
  it('uses local calendar dates for Today, Yesterday and This year', () => {
    const now=new Date(2026,0,1,0,30)
    expect(fastCaptureDate('today',now)).toEqual({precision:'exact',confidence:'confirmed',start:'2026-01-01'})
    expect(fastCaptureDate('yesterday',now).start).toBe('2025-12-31')
    expect(fastCaptureDate('year',now)).toEqual({precision:'year',confidence:'confirmed',start:'2026-01-01'})
  })
  it('preserves approximate years without inventing an exact day', async () => {
    const date={...fastCaptureDate('approximate'),start:'2012'},{entry}=await saveCaptureMemory({...draft(),body:'Maybe that year',eventDate:date})
    expect(entry.eventDate).toEqual({precision:'approximate',confidence:'approximate',start:'2012'});expect(dateLabel(date)).toBe('About 2012')
    expect(eventSpan(date)).toEqual({start:calendarDate('2012-01-01'),end:calendarDate('2013-01-01')!-1,uncertain:true})
  })
  it('keeps approximate ages unpositioned and offers age only with a profile', async () => {
    const value={...draft(),body:'Childhood',eventDate:{...fastCaptureDate('age'),age:12}},{entry}=await saveCaptureMemory(value)
    expect(entry.eventDate.start).toBeUndefined();expect(eventSpan(entry.eventDate)).toBeUndefined()
    const props={draftKey:'test',initialDraft:draft(),onSave:saveCaptureMemory,onClose:noop,onOpenEditor:noop,onDraftChange:noop}
    expect(renderToStaticMarkup(<QuickCaptureView {...props}/>)).not.toContain('About my age')
    expect(renderToStaticMarkup(<QuickCaptureView {...props} birthDate="1990-05-01"/>)).toContain('About my age')
  })
  it('recovers identity, text, timestamps, date and media without a canonical write', async () => {
    const local=storage(),key=captureDraftKey('test'),value={...draft(),body:'Unfinished thought',mediaIds:['original'],eventDate:{...fastCaptureDate('approximate'),start:'2012'}}
    writeCaptureDraft(key,value,local);expect(readCaptureDraft(key,local)).toEqual(value)
    expect(await db.entries.count()).toBe(0);expect(await db.memoryRevisions.count()).toBe(0);expect(captureDraftKey('other')).not.toBe(key)
  })
  it('discard removes only the draft, not original media', async () => {
    const local=storage(),key='test';await db.media.add(media('original'))
    writeCaptureDraft(key,{...draft(),body:'Draft',mediaIds:['original']},local);discardCaptureDraft(key,local)
    expect(readCaptureDraft(key,local)).toBeNull();expect(await db.media.count()).toBe(1);expect(await db.entries.count()).toBe(0)
    expect(renderToStaticMarkup(<QuickCaptureDraftBanner available onResume={noop} onDiscard={noop}/>)).toContain('Resume draft')
    expect(renderToStaticMarkup(<QuickCaptureDraftBanner available={false} onResume={noop} onDiscard={noop}/>)).toBe('')
  })
  it('does not retain empty openings and safely ignores malformed drafts', () => {
    const local=storage();writeCaptureDraft('test',draft(),local);expect(local.getItem('test')).toBeNull()
    for(const json of ['invalid','{}','{"version":1,"entry":{"body":"story"}}']) {local.setItem('test',json);expect(readCaptureDraft('test',local)).toBeNull()}
  })
  it('recovers incomplete dates but refuses to save invented dates', () => {
    const local=storage(),value={...draft(),body:'Keep my story',eventDate:{...fastCaptureDate('approximate'),start:'20'}}
    writeCaptureDraft('test',value,local);expect(readCaptureDraft('test',local)).toEqual(value)
    expect(() => capturedMemory(value)).toThrow('approximate year');expect(captureDateError(fastCaptureDate('age'))).toContain('approximate age')
    expect(captureDateError({...fastCaptureDate('age'),age:-1})).toContain('approximate age')
  })
  it('surfaces storage failure without mutating canonical memories', async () => {
    const unavailable={...storage(),setItem:() => {throw new Error('Quota')}}
    expect(() => writeCaptureDraft('test',{...draft(),body:'Still in editor'},unavailable)).toThrow('Quota');expect(await db.entries.count()).toBe(0)
  })
  it('shares concurrent/late submissions, creating exactly one Memory', async () => {
    const callback=vi.fn(saveCaptureMemory),submit=captureSubmission(callback),value={...draft(),body:'Save once'},first=submit(value),second=submit(value)
    expect(first).toBe(second);await Promise.all([first,second]);await submit(value)
    expect(callback).toHaveBeenCalledTimes(1);expect(await db.entries.count()).toBe(1);expect(await db.memoryRevisions.count()).toBe(0)
  })
  it('allows retry with the same identity and preserves the recoverable story on failure', async () => {
    const local=storage(),value={...draft(),body:'Never lose this'};writeCaptureDraft('test',value,local)
    const callback=vi.fn().mockRejectedValueOnce(new Error('Disk unavailable')).mockImplementation(saveCaptureMemory),submit=captureSubmission(callback)
    await expect(submit(value)).rejects.toThrow('Disk unavailable');expect(readCaptureDraft('test',local)).toEqual(value)
    await submit(readCaptureDraft('test',local)!);expect(await db.entries.count()).toBe(1);expect(callback).toHaveBeenCalledTimes(2)
  })
  it('creates ordinary revision history only after a later meaningful edit', async () => {
    const {entry}=await saveCaptureMemory({...draft(),body:'Original capture'});expect((await memoryHistory(entry.id)).total).toBe(0)
    await saveMemory({...entry,body:'Later elaboration'},{source:'editor',checkpointKey:'editor:0'})
    const history=await memoryHistory(entry.id)
    expect(history.total).toBe(1);expect(history.revisions[0].snapshot.body).toBe('Original capture')
    expect((await archive({includeRevisions:true})).revisions).toHaveLength(1)
  })
  it('is immediately keyword-searchable/filterable without enabling or calling AI', async () => {
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Offline'))
    try {
      const {entry}=await saveCaptureMemory({...draft(),body:'Grandmother made orange marmalade',eventDate:{...fastCaptureDate('approximate'),start:'2012'}}),data=await archive()
      expect(keywordSearch(data,'marmalade',{fromYear:2012,toYear:2012,entryType:'memory'})[0].entry.id).toBe(entry.id)
      expect(keywordSearch(data,'marmalade',{fromYear:2013})).toEqual([]);expect(buildSearchDocument(entry,data).text).toContain('orange marmalade')
      expect(await db.semanticSettings.count()).toBe(0);expect(await db.semanticVectors.count()).toBe(0);expect(network).not.toHaveBeenCalled()
    } finally {network.mockRestore()}
  })
  it('omits deleted attachments, preserves story and never recreates files', async () => {
    await db.media.add(media('present'))
    const {entry,warnings}=await saveCaptureMemory({...draft(),body:'Story survives',mediaIds:['present','deleted']})
    expect(entry.mediaIds).toEqual(['present']);expect(entry.body).toBe('Story survives');expect(warnings[0]).toContain('unavailable');expect(await db.media.count()).toBe(1)
    await expect(saveCaptureMemory({...draft(),body:'',mediaIds:['deleted']})).rejects.toThrow('no longer available')
  })
  it('offers Done/full editor and reuses the existing editor for saved captures', () => {
    const entry=capturedMemory({...draft(),body:'Captured story'}),success=renderToStaticMarkup(<CaptureSaved result={{entry,warnings:[]}} onDone={noop} onOpenEditor={noop}/>)
    expect(success).toContain('Unsorted Memories');expect(success).toContain('Done');expect(success).toContain('Open full editor')
    const html=renderToStaticMarkup(<MemoryDetailView entry={entry} initialEditing data={{entries:[entry],people:[],places:[],tags:[],eras:[]}} onPersist={async () => {}} onClose={noop} onDelete={noop} onAdd={{person:async () => undefined,place:async () => undefined,tag:async () => undefined,era:async () => undefined}}/>)
    expect(html).toContain('<textarea');expect(html).toContain('Captured story');expect(html).toContain('ATTACHMENTS')
  })
  it('renders approximate-year captures at the same granularity in the full editor', () => {
    const entry=capturedMemory({...draft(),body:'Around that year',eventDate:{precision:'approximate',confidence:'approximate',start:'2012'}})
    const html=renderToStaticMarkup(<MemoryDetailView entry={entry} initialEditing data={{entries:[entry],people:[],places:[],tags:[],eras:[]}} onPersist={async () => {}} onClose={noop} onDelete={noop} onAdd={{person:async () => undefined,place:async () => undefined,tag:async () => undefined,era:async () => undefined}}/>)
    expect(html).toContain('Approximate year');expect(html).toContain('value="2012"');expect(html).not.toContain('type="date"')
  })
})

describe('independent attachments and safe shortcuts', () => {
  it('disables compact attachment mutations while canonical save is pending', () => {
    const html=renderToStaticMarkup(<AttachmentPanel compact disabled mediaIds={[]} onChange={noop}/>)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add Photo/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add File/)
  })
  it('continues after an original import failure and leaves the story untouched', async () => {
    const value={...draft(),body:'Text survives'},save=vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(media('good')),thumbnail=vi.fn().mockResolvedValue(media('good'))
    const result=await importCaptureFiles([new File(['x'],'bad.png'),new File(['y'],'good.png')],[],{save,thumbnail})
    expect(result.ids).toEqual(['good']);expect(result.errors[0]).toContain('Your text is safe');expect(value.body).toBe('Text survives')
    expect(save).toHaveBeenCalledTimes(2);expect(thumbnail).toHaveBeenCalledTimes(1)
  })
  it('retains originals when previews fail and deduplicates attachment IDs', async () => {
    const result=await importCaptureFiles([new File(['x'],'original.png')],['original'],{save:async () => media('original'),thumbnail:async () => {throw new Error('Decode')}})
    expect(result.ids).toEqual(['original']);expect(result.errors[0]).toContain('original added')
  })
  it('accepts Ctrl/Cmd shortcuts but ignores typing, modals, repeats and unrelated keys', () => {
    const event={key:'M',ctrlKey:true,metaKey:false,shiftKey:true,altKey:false},context={editable:false,modalOpen:false}
    expect(shouldOpenCapture(event,context)).toBe(true);expect(shouldOpenCapture({...event,ctrlKey:false,metaKey:true},context)).toBe(true)
    expect(shouldOpenCapture(event,{...context,editable:true})).toBe(false);expect(shouldOpenCapture(event,{...context,modalOpen:true})).toBe(false)
    for(const patch of [{shiftKey:false},{altKey:true},{repeat:true},{key:'N'}]) expect(shouldOpenCapture({...event,...patch},context)).toBe(false)
  })
})
