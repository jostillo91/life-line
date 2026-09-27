import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { archive, db, importArchive, initializeArchive } from './db'
import { dateLabel, sorted } from './date'
import { hasDuplicateTag } from './domain'
import { EntityViews } from './EntityViews'
import { DateMoveDialog } from './DateMoveDialog'
import { moveEventDate } from './dateMove'
import { MemoryDetailView } from './MemoryDetailView'
import { MemoryDraftBanner } from './MemoryDraftBanner'
import { MemoryEditorView } from './MemoryEditorView'
import { MemoryHistoryView } from './MemoryHistoryView'
import { QuickCaptureDraftBanner, QuickCaptureView } from './QuickCaptureView'
import { PwaStatus } from './PwaStatus'
import { trackLocalWrite } from './pwaSafety'
import { captureDraftKey, discardCaptureDraft, QUICK_CAPTURE_SHORTCUT, readCaptureDraft, shouldOpenCapture } from './quickCaptureDomain'
import { saveCaptureMemory } from './quickCaptureService'
import { deleteMemoryWithHistory, saveMemory, undoMemoryDeletion, type MemorySaveOptions } from './memoryRevisionService'
import { MediaLibrary } from './MediaLibrary'
import { mapFocusForMedia, mapFocusForPlace } from './lifeMapDomain'
import { PrimaryNavigation, type View } from './PrimaryNavigation'
import { UnsortedMemoriesView } from './UnsortedMemoriesView'
import { TimelineView } from './TimelineView'
import { seed } from './seed'
import type { Archive, Entry, EventDate, Media, Place } from './types'
import type { MapFocus } from './LifeMapView'
import './styles.css'

const DataManagementView = lazy(() => import('./DataManagementView').then(module => ({ default: module.DataManagementView })))
const LifeMapView = lazy(() => import('./LifeMapView').then(module => ({ default: module.LifeMapView })))
const SearchView = lazy(() => import('./SearchView').then(module => ({ default: module.SearchView })))

type Undo = { message: string; restore: () => Promise<void> }
const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()
const quickDraftKey = captureDraftKey(db.name)
const blank = (overrides: Partial<Entry> = {}): Entry => {
  const timestamp = now()
  return {
    id: uid(), title: '', body: '', entryType: 'memory',
    eventDate: { precision: 'unknown', confidence: 'unknown' },
    recordTime: timestamp, createdAt: timestamp, updatedAt: timestamp, importance: 1,
    status: 'active', peopleIds: [], placeIds: [], tagIds: [], mediaIds: [], relatedEntryIds: [],
    ...overrides,
  }
}

export default function App() {
  const [data, setData] = useState<Archive>({ entries: [], people: [], places: [], tags: [], eras: [] })
  const [view, setView] = useState<View>('timeline')
  const [selected, setSelected] = useState<Entry | null>(null)
  const [historyId, setHistoryId] = useState<string>()
  const [captureOpen,setCaptureOpen] = useState(false)
  const [captureDraftAvailable,setCaptureDraftAvailable] = useState(() => Boolean(readCaptureDraft(quickDraftKey)))
  const [captureDraftError,setCaptureDraftError] = useState('')
  const [openInEditorId,setOpenInEditorId] = useState<string>()
  const [isNew, setNew] = useState(false)
  const [moving, setMoving] = useState<Entry | null>(null)
  const [dragging, setDragging] = useState<Entry | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const [mapFocus, setMapFocus] = useState<MapFocus>()
  const [focusedPlace, setFocusedPlace] = useState<{ id: string; nonce: number }>()
  const [focusedMedia, setFocusedMedia] = useState<{ id: string; nonce: number }>()
  const [askSeed, setAskSeed] = useState<{ question: string; nonce: number }>()
  const load = async () => setData(await archive())
  const refreshCaptureDraft = () => setCaptureDraftAvailable(Boolean(readCaptureDraft(quickDraftKey)))
  function openCapture() {if (!document.querySelector('.overlay')) setCaptureOpen(true)}
  function closeCapture() {setCaptureOpen(false);refreshCaptureDraft();void load()}
  function discardCapture() {
    try {discardCaptureDraft(quickDraftKey);refreshCaptureDraft();setCaptureDraftError('')}
    catch {setCaptureDraftError('This browser could not discard the capture draft. Please try again.')}
  }
  useEffect(() => {
    const shortcut = (event:KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (shouldOpenCapture(event,{editable:Boolean(target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')),modalOpen:Boolean(document.querySelector('.overlay,[role="dialog"],[role="alertdialog"]'))})) {
        event.preventDefault();setCaptureOpen(true)
      }
    }
    const draftChanged = (event:StorageEvent) => {if (event.key === quickDraftKey) refreshCaptureDraft()}
    window.addEventListener('keydown',shortcut);window.addEventListener('storage',draftChanged)
    return () => {window.removeEventListener('keydown',shortcut);window.removeEventListener('storage',draftChanged)}
  },[])

  useEffect(() => { (async () => {
    await initializeArchive(import.meta.env.DEV ? seed : {entries:[],people:[],places:[],tags:[],eras:[]})
    await load()
  })() }, [])

  useEffect(() => {
    if (undo) { const timer = setTimeout(() => setUndo(null), 7000); return () => clearTimeout(timer) }
  }, [undo])

  async function persist(entry: Entry, close = false, options?: MemorySaveOptions) {
    return trackLocalWrite(async () => {
      const saved = await saveMemory(entry, {...options,requireExisting:!isNew})
      await load()
      if (!close) setSelected(current => current?.id === entry.id ? saved : current)
      if (close) { setSelected(null); setNew(false) }
    })
  }

  async function commitMove(entry: Entry, date: EventDate) {
    const before = entry.eventDate
    const changed = moveEventDate(entry, date)
    await persist(changed, false, {source:'dateMove'})
    setMoving(null)
    setUndo({ message: `Moved “${entry.title}” to ${dateLabel(date)}`, restore: async () => { const current = await db.entries.get(entry.id); if (current) await persist(moveEventDate(current, before), false, {source:'undo'}); await load() } })
  }

  async function applyAssistantEdit(entry: Entry) {
    const before = await db.entries.get(entry.id)
    await persist(entry, false, {source:'assistantAccepted'})
    if (before) setUndo({ message: 'Assistant suggestion added to memory', restore: async () => persist(before, false, {source:'undo'}) })
  }

  async function deleteEntry(entry: Entry) {
    const deleted = await deleteMemoryWithHistory(entry.id)
    await load(); setSelected(null);setOpenInEditorId(undefined)
    if (deleted) setUndo({ message: 'Memory deleted', restore: async () => { await undoMemoryDeletion(deleted); await load() } })
  }

  async function add(kind: 'person' | 'place' | 'tag' | 'era', name: string) {
    const clean = name.trim(); if (!clean) return
    if (kind === 'tag') {
      const found = data.tags.find(tag => hasDuplicateTag([tag], clean)); if (found) return found.id
      const id = uid(); await db.tags.put({ id, name: clean, color: '#5d7fa3' }); await load(); return id
    }
    const table = kind === 'person' ? db.people : kind === 'place' ? db.places : db.eras
    const items = kind === 'person' ? data.people : kind === 'place' ? data.places : data.eras
    const existing = items.find(item => item.name.trim().toLowerCase() === clean.toLowerCase()); if (existing) return existing.id
    const id = uid(); await table.put({ id, name: clean }); await load(); return id
  }

  function exportJSON() {
    archive({includeRevisions:true,includeDeleted:true}).then(value => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify({ format: 'life-line-archive', version: 3, data: value })])); link.download = 'life-line-archive.json'; link.click() })
  }

  async function importJSON(file: File) {
    try { const raw = JSON.parse(await file.text()); if (raw?.format !== 'life-line-archive' || ![1,2,3].includes(raw.version)) throw Error(); await importArchive(raw.data, confirm('Replace existing memories, Recovery Center and their history? Cancel merges instead.') ? 'replace' : 'merge'); await load() }
    catch { alert('Invalid archive; nothing changed.') }
  }

  const unsorted = useMemo(() => sorted(data.entries.filter(entry => ['unknown', 'age'].includes(entry.eventDate.precision))), [data.entries])
  function openHistory(entry: Entry) { setSelected(null); setOpenInEditorId(undefined);setHistoryId(entry.id) }
  function reviewDate(entry: Entry) { setSelected(null);setOpenInEditorId(undefined); setMoving(entry) }

  function openMapAt(coordinates: { latitude: number; longitude: number }, pointId?: string) {
    setMapFocus({ coordinates, pointId, nonce: Date.now() })
    setView('map')
  }
  function openPlaceFromMap(place: Place) {
    setFocusedPlace({ id: place.id, nonce: Date.now() })
    setView('places')
  }
  function openMediaFromMap(media: Media) {
    setFocusedMedia({ id: media.id, nonce: Date.now() })
    setView('media')
  }

  return <main>
    <header><div><span className="eyebrow">PRIVATE LIFE ARCHIVE</span><h1>Life Line</h1></div><div className="actions"><button className="primary capture-open" title={QUICK_CAPTURE_SHORTCUT} aria-keyshortcuts="Control+Shift+M Meta+Shift+M" onClick={openCapture}>Quick Capture</button><button className="quiet" onClick={exportJSON}>Export JSON</button><label className="quiet import">Import JSON<input type="file" accept="application/json" onChange={event => event.target.files?.[0] && importJSON(event.target.files[0])}/></label><button className="primary" onClick={() => { setSelected(blank()); setNew(true) }}>+ Add memory</button></div></header>
    <PrimaryNavigation currentView={view} onViewChange={next => { setMapFocus(undefined); setView(next) }} />
    <PwaStatus/>
    {!selected && (
      <MemoryDraftBanner onResume={entry => { setSelected(entry); setNew(true) }}/>
    )}
    {!selected && !captureOpen && <QuickCaptureDraftBanner available={captureDraftAvailable} onResume={openCapture} onDiscard={discardCapture}/>}
    {captureDraftError && <p className="capture-error" role="alert">{captureDraftError}</p>}
    {view === 'search'
      ? <Suspense fallback={<p className="empty">Loading Search…</p>}><SearchView data={data} askSeed={askSeed} onOpenMemory={entry => { setSelected(entry); setNew(false) }} onViewTimeline={entry => { setView('timeline'); setSelected(entry); setNew(false) }}/></Suspense>
      : view === 'timeline'
      ? <TimelineView entries={data.entries} eras={data.eras} tags={data.tags} people={data.people} places={data.places} media={data.media ?? []} birthDate={data.profile?.birthDate} onSaveBirthDate={async birthDate => { await db.archiveSettings.put({ key: 'profile', value: { ...data.profile, birthDate: birthDate || undefined } }); await load() }} dragging={dragging} onDragMemory={setDragging} onOpenMemory={entry => { setSelected(entry); setNew(false) }} onMoveDate={setMoving} onViewUnsorted={() => setView('unsorted')}/>
      : view === 'unsorted'
        ? <UnsortedMemoriesView entries={unsorted} onOpenMemory={entry => { setSelected(entry); setNew(false) }} onDragMemory={setDragging}/>
        : view === 'media'
          ? <MediaLibrary media={data.media ?? []} entries={data.entries} places={data.places} focusedMedia={focusedMedia} onChanged={load} onOpenMemory={entry => { setSelected(entry); setNew(false) }} onCreateMemory={memory => { setSelected(blank(memory)); setNew(true) }} onViewOnMap={media => { const coordinates = mapFocusForMedia(media, data.places, data.media ?? []); if (coordinates) openMapAt(coordinates, media.placeId ? `place:${media.placeId}` : `media:${media.id}`) }} onViewCluster={coordinates => openMapAt(coordinates)}/>
          : view === 'map'
            ? <Suspense fallback={<p className="empty">Loading Life Map…</p>}><LifeMapView data={data} onChanged={load} focus={mapFocus} onOpenPlace={openPlaceFromMap} onOpenMedia={openMediaFromMap} onOpenMemory={entry => { setSelected(entry); setNew(false) }}/></Suspense>
          : view === 'data'
            ? <Suspense fallback={<p className="empty">Loading backup tools…</p>}><DataManagementView data={data} onChanged={async()=>{setUndo(null);await load()}} onExportJson={exportJSON} onImportJson={importJSON}/></Suspense>
            : <EntityViews view={view} data={data} onChanged={load} onOpenEntries={() => setView('timeline')} focusedPlace={focusedPlace} onViewOnMap={place => { const coordinates = mapFocusForPlace(place, data.media ?? []); if (coordinates) openMapAt(coordinates, `place:${place.id}`) }} onViewCluster={coordinates => openMapAt(coordinates)}/>
    }
    {selected && (isNew
      ? <MemoryEditorView entry={selected} data={data} isNew onPersist={persist} onDelete={deleteEntry} onClose={() => { setSelected(null); setNew(false) }} onReviewDate={setMoving} onAdd={{ person: name => add('person', name), place: name => add('place', name), tag: name => add('tag', name), era: name => add('era', name) }}/>
      : <MemoryDetailView key={selected.id} entry={selected} data={data} initialEditing={openInEditorId === selected.id} onPersist={async (entry,close,options) => {await persist(entry,close,options);if(close)setOpenInEditorId(undefined)}} onAssistantApply={applyAssistantEdit} onDelete={deleteEntry} onClose={() => { setSelected(null); setNew(false);setOpenInEditorId(undefined) }} onHistory={openHistory} onAskPeriod={entry => { setAskSeed({ question: `What was happening around ${entry.title}?`, nonce: Date.now() }); setSelected(null); setView('search') }} onReviewDate={reviewDate} onAdd={{ person: name => add('person', name), place: name => add('place', name), tag: name => add('tag', name), era: name => add('era', name) }}/>
    )}
    {captureOpen && <QuickCaptureView draftKey={quickDraftKey} birthDate={data.profile?.birthDate} onSave={async entry => {const result=await saveCaptureMemory(entry);await load();return result}} onClose={closeCapture} onDraftChange={refreshCaptureDraft} onOpenEditor={entry => {setCaptureOpen(false);setSelected(entry);setNew(false);setOpenInEditorId(entry.id);refreshCaptureDraft()}}/>}
    {historyId && <MemoryHistoryView memoryId={historyId} data={data} onChanged={async () => {setUndo(null);await load()}} onClose={() => setHistoryId(undefined)}/>}
    {moving && (
      <DateMoveDialog entry={moving} onConfirm={date => commitMove(moving, date)} onClose={() => setMoving(null)}/>
    )}
    {undo && <div className="notice">{undo.message}<button onClick={async () => { await undo.restore(); setUndo(null) }}>Undo</button></div>}
  </main>
}
