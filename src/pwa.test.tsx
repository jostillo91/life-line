import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { pwaOptions } from '../pwa.config'
import { PwaStatusContent } from './PwaStatus'
import { isOnline } from './networkState'
import { canReloadAfterUpdate, persistenceLabel, trackLocalWrite, updateBlockReason } from './pwaSafety'
import { requestStoragePersistence, readMediaFile, saveMediaFile } from './mediaStorage'
import { createRemoteAIProvider } from './remoteAIProvider'
import { createRemoteEmbeddingProvider } from './embeddingProvider'
import { createRemoteAskProvider } from './askProvider'
import { getRemoteAIStatus } from './remoteAISession'
import { createMapTilerGeocoder } from './reverseGeocoder'
import { buildAIContext, defaultContextSelection } from './assistantDomain'
import { seed } from './seed'
import { db, archive } from './db'
import { capturedMemory, newCaptureDraft } from './quickCaptureDomain'
import { saveCaptureMemory } from './quickCaptureService'
import { memoryHistory, saveMemory } from './memoryRevisionService'
import { createLifeLineArchive, inspectLifeLineArchive, restoreLifeLineArchive } from './archiveService'
import { decryptLifeLineArchive, encryptLifeLineArchive } from './encryptedArchive'

const noop = () => {}
const idle = {querySelector:() => null,activeElement:null}
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks()})
describe('installable app shell and safe PWA controls', () => {
  it('defines stable identity, scope, launch/display/colors and both standard/maskable icons', () => {
    expect(pwaOptions.manifest).toMatchObject({name:'Life Line',short_name:'Life Line',id:'/',scope:'/',start_url:'/',display:'standalone',theme_color:'#2f5d50',background_color:'#f4f1e9'})
    expect(pwaOptions.manifest && pwaOptions.manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({sizes:'192x192',purpose:'any'}),expect.objectContaining({sizes:'512x512',purpose:'any'}),expect.objectContaining({sizes:'512x512',purpose:'maskable'})]))
  })
  it('ships real PNG installation assets at declared sizes and Apple size', () => {
    for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['icon-maskable-512.png',512],['apple-touch-icon.png',180]] as const) {
      const png=readFileSync(new URL(`../public/icons/${name}`,import.meta.url))
      expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');expect(png.readUInt32BE(16)).toBe(size);expect(png.readUInt32BE(20)).toBe(size)
    }
  })
  it('precaches only application resources, not API/archive/media/runtime data, and disables dev workers', () => {
    expect(pwaOptions.workbox?.globPatterns).toEqual(['index.html','assets/*.{js,css,woff2}','favicon.svg','icons/*.png'])
    expect(pwaOptions.workbox?.runtimeCaching).toEqual([])
    expect(pwaOptions.workbox?.skipWaiting).toBe(false);expect(pwaOptions.registerType).toBe('prompt');expect(pwaOptions.devOptions?.enabled).toBe(false)
    expect(pwaOptions.workbox?.navigateFallbackAllowlist?.[0].test('/')).toBe(true)
    expect(pwaOptions.workbox?.navigateFallbackAllowlist?.[0].test('/api/memory-assistant')).toBe(false)
    expect(pwaOptions.workbox?.navigateFallbackAllowlist?.[0].test('/backup.zip')).toBe(false)
  })
  it('shows subtle offline status and only offers installation when supported', () => {
    const html=renderToStaticMarkup(<PwaStatusContent online={false} onInstall={noop} onUpdate={noop}/>)
    expect(html).toContain('Offline');expect(html).toContain('local archive available');expect(html).not.toContain('Install Life Line')
    expect(renderToStaticMarkup(<PwaStatusContent online installable onInstall={noop} onUpdate={noop}/>)).toContain('Install Life Line')
  })
  it('offers user-controlled updates, disables them offline and never uses automatic update mode', () => {
    expect(renderToStaticMarkup(<PwaStatusContent online update onInstall={noop} onUpdate={noop}/>)).toContain('Update when ready')
    expect(renderToStaticMarkup(<PwaStatusContent online={false} update onInstall={noop} onUpdate={noop}/>)).toContain('disabled=""')
    expect(updateBlockReason(idle)).toBeUndefined()
    expect(updateBlockReason({...idle,querySelector:() => ({} as Element)})).toContain('Finish and close')
    expect(updateBlockReason(idle,1)).toContain('finish saving')
    expect(updateBlockReason({...idle,activeElement:{closest:() => ({} as Element)} as unknown as Element})).toContain('entering text')
  })
  it('blocks reload throughout a pending local save and releases the lock even on failure', async () => {
    let finish!:()=>void
    const pending=trackLocalWrite(() => new Promise<void>(resolve => {finish=resolve}))
    expect(updateBlockReason(idle)).toContain('finish saving');expect(canReloadAfterUpdate(true,idle)).toBe(false);finish();await pending;expect(updateBlockReason(idle)).toBeUndefined()
    await expect(trackLocalWrite(async () => {throw new Error('Storage failed')})).rejects.toThrow('Storage failed');expect(updateBlockReason(idle)).toBeUndefined()
  })
  it('never reloads an unconsenting window or an editor opened during update activation', () => {
    expect(canReloadAfterUpdate(false,idle)).toBe(false)
    expect(canReloadAfterUpdate(true,idle)).toBe(true)
    expect(canReloadAfterUpdate(true,{...idle,querySelector:() => ({} as Element)})).toBe(false)
  })
  it('handles granted/denied/unsupported/failing storage persistence without a guarantee', async () => {
    expect(await requestStoragePersistence({persist:async () => true})).toBe('granted')
    expect(await requestStoragePersistence({persist:async () => false})).toBe('denied')
    expect(await requestStoragePersistence({} as StorageManager)).toBe('unsupported')
    expect(await requestStoragePersistence({persist:async () => {throw Error('Unavailable')}})).toBe('error')
    expect(persistenceLabel()).toContain('unavailable');expect(persistenceLabel(false)).toContain('not granted');expect(persistenceLabel(true)).toContain('granted')
  })
})

describe('offline provider boundaries and local archive', () => {
  beforeEach(async () => {db.close();await db.delete();await db.open();vi.stubGlobal('navigator',{onLine:false})})
  afterEach(() => db.close())
  it('makes no remote AI/status/embedding/Ask/geocode request when offline', async () => {
    const fetcher=vi.fn(),signal=new AbortController().signal
    const context=buildAIContext('remember',seed.entries[0],seed,defaultContextSelection())
    await expect(createRemoteAIProvider('/api',fetcher).generate({task:'remember',context,safetyInstructions:''},signal)).rejects.toThrow('offline')
    const embeddings=createRemoteEmbeddingProvider('/api',fetcher)
    await expect(embeddings.info()).rejects.toThrow('offline');await expect(embeddings.embedQuery('school',signal)).rejects.toThrow('offline');await expect(embeddings.embedDocuments(['school'],signal)).rejects.toThrow('offline')
    await expect(createRemoteAskProvider('/api',fetcher).answer({question:'school',evidence:[]},signal)).rejects.toThrow('offline')
    expect(await getRemoteAIStatus('/api',fetcher)).toBe('unavailable')
    await expect(createMapTilerGeocoder('test-key',{fetcher}).lookup({latitude:33,longitude:-112})).rejects.toThrow('offline')
    expect(fetcher).not.toHaveBeenCalled();expect(isOnline()).toBe(false)
  })
  it('preserves local vectors through offline provider failures and recovers on reconnect', async () => {
    const vector={memoryId:'existing',sourceType:'memory' as const,model:'model',dimension:1,indexVersion:1,fingerprint:'same',generatedAt:'2026-09-27',vector:[1]}
    await db.semanticVectors.put(vector)
    const fetcher=vi.fn(async () => new Response(JSON.stringify({embedding:{status:'ready',model:'model',dimension:1}})))
    const provider=createRemoteEmbeddingProvider('/api',fetcher)
    await expect(provider.info()).rejects.toThrow('offline');expect(await db.semanticVectors.get('existing')).toEqual(vector)
    vi.stubGlobal('navigator',{onLine:true});expect(await provider.info()).toEqual({model:'model',dimension:1});expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('captures, edits, reads media, exports/encrypts and restores locally with all fetches unavailable', async () => {
    const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Offline'))
    const original=new File(['local original bytes'],'local-photo.txt',{type:'text/plain'})
    const media=await saveMediaFile(original)
    const draft={...newCaptureDraft(new Date('2026-09-27T12:00:00Z')),body:'An offline captured thought',mediaIds:[media.id]}
    const {entry}=await saveCaptureMemory(draft)
    expect(entry).toMatchObject({...capturedMemory(draft),updatedAt:entry.updatedAt});expect(entry.eventDate.precision).toBe('unknown')
    await saveMemory({...entry,body:'An offline edit'})
    expect((await memoryHistory(entry.id)).total).toBe(1)
    expect(await (await readMediaFile(media))!.text()).toBe('local original bytes')
    const backup=await createLifeLineArchive(),password='test-only-backup-password'
    const encrypted=await encryptLifeLineArchive(backup.blob,password)
    const decoded=await decryptLifeLineArchive(encrypted,password)
    const inspected=await inspectLifeLineArchive(decoded)
    expect(inspected.data.entries[0].body).toBe('An offline edit')
    await restoreLifeLineArchive(inspected,'merge')
    expect((await archive()).entries).toHaveLength(1);expect(await db.mediaFiles.count()).toBe(1)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
