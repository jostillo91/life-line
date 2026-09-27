import { useState } from 'react'
import { DateMoveDialog } from './DateMoveDialog'
import { MemoryDetailView } from './MemoryDetailView'
import { moveEventDate, restoreEventDate } from './dateMove'
import { seed } from './seed'
import { TimelineView } from './TimelineView'
import { createTimelineFixture } from './timelineFixture'
import { centerOf, timelineExtent } from './timelineLayout'
import type { Archive, Entry } from './types'
import './styles.css'

function smallFixture(): Archive {
  const data = structuredClone(seed), sample = data.entries[0]
  data.entries.push(
    { ...sample, id: 'preview-about', title: 'Approximate spring visit', importance: 2, eventDate: { precision: 'approximate', start: '2007-05-01', confidence: 'guess' } },
    { ...sample, id: 'preview-range', title: 'High School range', importance: 4, eventDate: { precision: 'range', start: '2006-09', end: '2010-06', confidence: 'likely' } },
    { ...sample, id: 'preview-month', title: 'Month-only trip', importance: 2, eventDate: { precision: 'month', start: '2014-06', confidence: 'confirmed' } },
    { ...sample, id: 'preview-future', title: 'Future plan', importance: 2, eventDate: { precision: 'exact', start: '2040-06-15', confidence: 'confirmed' } },
  )
  data.profile = { birthDate: '1991-06-15' }
  return data
}

/** DEV-only, isolated UI harness. Uses the real Timeline/detail/date dialog but never opens the archive DB. */
export function TimelinePlayground() {
  const mode = new URLSearchParams(location.search).get('timelineFixture')
  const [data, setData] = useState<Archive>(() => mode === 'empty' ? { entries: [], people: [], places: [], tags: [], eras: [] } : mode === 'large' ? createTimelineFixture() : smallFixture())
  const [selected, setSelected] = useState<Entry | null>(null)
  const [moving, setMoving] = useState<Entry | null>(null)
  const [dragging, setDragging] = useState<Entry | null>(null)
  const [beforeMove, setBeforeMove] = useState<Entry>()
  const persist = async (entry: Entry) => { setData(value => ({ ...value, entries: value.entries.map(item => item.id === entry.id ? entry : item) })); setSelected(value => value?.id === entry.id ? entry : value) }
  return <main><header><div><span className="eyebrow">ISOLATED DEVELOPMENT PREVIEW</span><h1>Life Line · {mode} fixture</h1></div></header>
    <p className="timeline-help">Synthetic, in-memory data only. Reload discards changes; your archive is not loaded or modified. Photo counts use metadata without fake binary requests.</p>
    <TimelineView entries={data.entries} eras={data.eras} tags={data.tags} people={data.people} places={data.places} media={data.media ?? []} birthDate={data.profile?.birthDate}
      initialPosition={{ focus: centerOf(timelineExtent(data.entries, data.eras, data.profile?.birthDate)), zoom: 'Entire Life' }} previews={false}
      onSaveBirthDate={async birthDate => setData(value => ({ ...value, profile: { birthDate: birthDate || undefined } }))}
      dragging={dragging} onDragMemory={setDragging} onOpenMemory={setSelected} onMoveDate={setMoving}/>
    {selected && <MemoryDetailView entry={{ ...selected, mediaIds: [] }} data={data} onPersist={persist} onDelete={async () => undefined} onClose={() => setSelected(null)} onReviewDate={setMoving} onAdd={{ person: async () => undefined, place: async () => undefined, tag: async () => undefined, era: async () => undefined }}/>} 
    {moving && <DateMoveDialog entry={moving} onClose={() => setMoving(null)} onConfirm={async date => { setBeforeMove(moving); await persist(moveEventDate(moving, date)); setMoving(null) }}/>} 
    {beforeMove && <div className="notice">Fixture date moved<button onClick={async () => { const current = data.entries.find(item => item.id === beforeMove.id)!; await persist(restoreEventDate(current, beforeMove.eventDate)); setBeforeMove(undefined) }}>Undo</button></div>}
  </main>
}
