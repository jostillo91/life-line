import { useEffect, useMemo, useState } from 'react'
import { archive, db, importArchive } from './db'
import { dateLabel, sorted } from './date'
import { hasDuplicateTag } from './domain'
import { EntryEditor, clearRecoverableDraft, recoverableDraft } from './Editor'
import { EntityViews } from './EntityViews'
import { DateMoveDialog } from './DateMoveDialog'
import { moveEventDate } from './dateMove'
import { PrimaryNavigation, type View } from './PrimaryNavigation'
import { UnsortedMemoriesView } from './UnsortedMemoriesView'
import { TimelineView } from './TimelineView'
import { seed } from './seed'
import type { Archive, Entry, EventDate } from './types'
import './styles.css'

type Undo = { message: string; restore: () => Promise<void> }
const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()
const blank = (): Entry => ({
  id: uid(), title: '', body: '', entryType: 'memory',
  eventDate: { precision: 'unknown', confidence: 'unknown' },
  recordTime: now(), createdAt: now(), updatedAt: now(), importance: 1,
  status: 'active', peopleIds: [], placeIds: [], tagIds: [], mediaIds: [], relatedEntryIds: [],
})

export default function App() {
  const [data, setData] = useState<Archive>({ entries: [], people: [], places: [], tags: [], eras: [] })
  const [view, setView] = useState<View>('timeline')
  const [selected, setSelected] = useState<Entry | null>(null)
  const [isNew, setNew] = useState(false)
  const [moving, setMoving] = useState<Entry | null>(null)
  const [dragging, setDragging] = useState<Entry | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const load = async () => setData(await archive())

  useEffect(() => { (async () => {
    if (await db.entries.count() === 0) {
      await db.entries.bulkAdd(seed.entries)
      await db.people.bulkAdd(seed.people)
      await db.places.bulkAdd(seed.places)
      await db.tags.bulkAdd(seed.tags)
      await db.eras.bulkAdd(seed.eras)
    }
    await load()
  })() }, [])

  useEffect(() => {
    if (undo) { const timer = setTimeout(() => setUndo(null), 7000); return () => clearTimeout(timer) }
  }, [undo])

  async function persist(entry: Entry, close = false) {
    const old = await db.entries.get(entry.id)
    await db.entries.put({ ...entry, createdAt: old?.createdAt ?? entry.createdAt, recordTime: old?.recordTime ?? entry.recordTime, updatedAt: now() })
    await load()
    if (close) { setSelected(null); setNew(false) }
  }

  async function commitMove(entry: Entry, date: EventDate) {
    const before = entry.eventDate
    const changed = moveEventDate(entry, date)
    await persist(changed)
    setMoving(null)
    setUndo({ message: `Moved “${entry.title}” to ${dateLabel(date)}`, restore: async () => { await persist(moveEventDate(changed, before)); await load() } })
  }

  async function deleteEntry(entry: Entry) {
    await db.entries.delete(entry.id); await load(); setSelected(null)
    setUndo({ message: 'Memory deleted', restore: async () => { await db.entries.put(entry); await load() } })
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
    archive().then(value => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify({ format: 'life-line-archive', version: 1, data: value })])); link.download = 'life-line-archive.json'; link.click() })
  }

  async function importJSON(file: File) {
    try { const raw = JSON.parse(await file.text()); if (raw?.format !== 'life-line-archive') throw Error(); await importArchive(raw.data, confirm('Replace existing memories? Cancel merges instead.') ? 'replace' : 'merge'); await load() }
    catch { alert('Invalid archive; nothing changed.') }
  }

  const dated = useMemo(() => sorted(data.entries.filter(entry => !['unknown', 'age'].includes(entry.eventDate.precision))), [data.entries])
  const unsorted = useMemo(() => sorted(data.entries.filter(entry => ['unknown', 'age'].includes(entry.eventDate.precision))), [data.entries])

  return <main>
    <header><div><span className="eyebrow">PRIVATE LIFE ARCHIVE</span><h1>Life Line</h1></div><div className="actions"><button className="quiet" onClick={exportJSON}>Export</button><label className="quiet import">Import<input type="file" accept="application/json" onChange={event => event.target.files?.[0] && importJSON(event.target.files[0])}/></label><button className="primary" onClick={() => { setSelected(blank()); setNew(true) }}>+ Add memory</button></div></header>
    <PrimaryNavigation currentView={view} onViewChange={setView} />
    {recoverableDraft() && !selected && <button className="draft-banner" onClick={() => { setSelected(recoverableDraft()); setNew(true) }}>Resume unfinished memory <i onClick={event => { event.stopPropagation(); clearRecoverableDraft() }}>Discard</i></button>}
    {view === 'timeline'
      ? <TimelineView entries={dated} eras={data.eras} tags={data.tags} dragging={dragging} onDragMemory={setDragging} onOpenMemory={entry => { setSelected(entry); setNew(false) }} onMoveDate={setMoving}/>
      : view === 'unsorted'
        ? <UnsortedMemoriesView entries={unsorted} onOpenMemory={entry => { setSelected(entry); setNew(false) }} onDragMemory={setDragging}/>
        : <EntityViews view={view} data={data} onChanged={load} onOpenEntries={() => setView('timeline')}/>
    }
    {selected && <EntryEditor entry={selected} data={data} isNew={isNew} onPersist={persist} onDelete={deleteEntry} onClose={() => { setSelected(null); setNew(false) }} onAdd={{ person: name => add('person', name), place: name => add('place', name), tag: name => add('tag', name), era: name => add('era', name) }}/>} 
    {moving && <DateMoveDialog entry={moving} onConfirm={date => commitMove(moving, date)} onClose={() => setMoving(null)}/>} 
    {undo && <div className="notice">{undo.message}<button onClick={async () => { await undo.restore(); setUndo(null) }}>Undo</button></div>}
  </main>
}
