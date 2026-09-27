import { useEffect, useRef, useState } from 'react'
import { AttachmentPanel } from './AttachmentPanel'
import { MemoryAssistant } from './MemoryAssistant'
import { suggestedPlaceForMemory } from './locationDomain'
import type { Archive, Confidence, DatePrecision, Entry, EntryType, EventDate } from './types'
import { editorCheckpointKey, type MemorySaveOptions } from './memoryRevisionService'

const recoverableDraftKey = 'life-line:new-entry-draft'

export const recoverableDraft = () => {
  try {
    return JSON.parse(localStorage.getItem(recoverableDraftKey) ?? 'null') as Entry | null
  } catch {
    return null
  }
}

export const clearRecoverableDraft = () => localStorage.removeItem(recoverableDraftKey)

type AddEntity = (name: string) => Promise<string | undefined>

export interface MemoryEditorViewProps {
  entry: Entry
  data: Archive
  isNew: boolean
  onPersist: (entry: Entry, close?: boolean, options?: MemorySaveOptions) => Promise<void>
  onAssistantApply?: (entry: Entry) => Promise<void>
  onDelete: (entry: Entry) => void
  onClose: () => void
  onReviewDate?: (entry: Entry) => void
  onHistory?: (entry: Entry) => void
  onAdd: {
    person: AddEntity
    place: AddEntity
    tag: AddEntity
    era: AddEntity
  }
}

export function MemoryEditorView({ entry, data, isNew, onPersist, onDelete, onClose, onAdd, onReviewDate, onHistory }: MemoryEditorViewProps) {
  const [draft, setDraft] = useState<Entry>(() => isNew ? recoverableDraft() ?? entry : entry)
  const [saveState, setSaveState] = useState('Saved')
  const latest = useRef(draft)
  const initial = useRef(JSON.stringify(draft))
  const persist = useRef(onPersist)
  const finalized = useRef(false)
  const session = useRef({id:crypto.randomUUID(), startedAt:Date.now(), segment:0, source:'editor' as 'editor'|'assistantAccepted'})
  const saveQueue = useRef<Promise<void>>(Promise.resolve())

  latest.current = draft
  persist.current = onPersist
  function saveDraft(close = false) {
    const value = latest.current
    const options: MemorySaveOptions = {source:session.current.source, checkpointKey:`${editorCheckpointKey(session.current.id, session.current.startedAt)}:${session.current.segment}`}
    const pending = saveQueue.current.catch(() => {}).then(() => persist.current(value, close, options))
    saveQueue.current = pending
    return pending
  }
  function userEdit() {
    if (session.current.source === 'assistantAccepted') { session.current.segment++; session.current.source = 'editor' }
  }
  async function finish(action: () => void) {
    finalized.current = true
    try {
      if (!isNew) await saveDraft()
      else if (latest.current.title.trim()) localStorage.setItem(recoverableDraftKey, JSON.stringify(latest.current))
      action()
    } catch { finalized.current = false; setSaveState('Save failed — please try again') }
  }

  useEffect(() => {
    if (JSON.stringify(draft) === initial.current) return

    setSaveState('Unsaved changes')
    const timer = setTimeout(async () => {
      if (finalized.current) return
      setSaveState('Saving…')
      try {
        if (isNew) localStorage.setItem(recoverableDraftKey, JSON.stringify(latest.current))
        else await saveDraft()
        setSaveState('Saved')
      } catch { setSaveState('Save failed — please try again') }
    }, 650)

    return () => clearTimeout(timer)
  }, [draft, isNew])

  useEffect(() => () => {
    if (isNew && !finalized.current && latest.current.title.trim()) {
      localStorage.setItem(recoverableDraftKey, JSON.stringify(latest.current))
    }
  }, [isNew])

  const updateDraft = (patch: Partial<Entry>) => { userEdit(); setDraft(value => ({ ...value, ...patch })) }
  const updateEventDate = (patch: Partial<Entry['eventDate']>) => {
    userEdit()
    setDraft(value => ({ ...value, eventDate: { ...value.eventDate, ...patch } }))
  }

  const addEntity = async (
    field: 'peopleIds' | 'placeIds' | 'tagIds',
    create: AddEntity,
    label: string,
  ) => {
    const name = prompt(`Create ${label}`)
    if (!name?.trim()) return

    const id = await create(name)
    if (id) {
      userEdit()
      setDraft(value => ({ ...value, [field]: [...new Set([...value[field], id])] }))
    }
  }

  const precision = draft.eventDate.precision
  const suggestedPlaceId = suggestedPlaceForMemory(draft, data.media ?? [])
  const suggestedPlace = suggestedPlaceId && !draft.placeIds.includes(suggestedPlaceId)
    ? data.places.find(place => place.id === suggestedPlaceId)
    : undefined

  return (
    <div className="overlay">
      <form
        className="editor"
        onSubmit={async event => {
          event.preventDefault()
          if (draft.title.trim()) {
            finalized.current = true
            try {
              await saveDraft(true)
              clearRecoverableDraft()
            } catch {
              finalized.current = false
              setSaveState('Save failed — please try again')
            }
          }
        }}
      >
        <div className="editor-head">
          <span className="eyebrow">{isNew ? 'NEW MEMORY' : 'EDIT MEMORY'} · <b>{saveState}</b></span>
          <button type="button" className="close" onClick={() => void finish(onClose)} aria-label="Close editor">×</button>
        </div>
        <input
          className="title"
          autoFocus
          value={draft.title}
          placeholder="Give this moment a title"
          onChange={event => updateDraft({ title: event.target.value })}
        />
        <textarea
          rows={7}
          value={draft.body}
          placeholder="Tell the story—details can come later."
          onChange={event => updateDraft({ body: event.target.value })}
        />
        <div className="form-grid">
          <label>
            Kind
            <select value={draft.entryType} onChange={event => updateDraft({ entryType: event.target.value as EntryType })}>
              {['memory', 'story', 'event', 'journal', 'milestone'].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            Date certainty
            <select value={precision} onChange={event => updateEventDate({ precision: event.target.value as DatePrecision })}>
              {['unknown', 'exact', 'month', 'year', 'approximate', 'range', 'season', 'age'].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <EventDateFields key={precision} eventDate={draft.eventDate} onChange={updateEventDate}/>
          <label>
            Confidence
            <select value={draft.eventDate.confidence} onChange={event => updateEventDate({ confidence: event.target.value as Confidence })}>
              {['confirmed', 'likely', 'approximate', 'guess', 'unknown'].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            Importance
            <input type="number" min="1" max="5" value={draft.importance} onChange={event => updateDraft({ importance: Math.min(5, Math.max(1, Number(event.target.value) || 1)) })}/>
          </label>
          <EntityPicker
            label="People"
            ids={draft.peopleIds}
            items={data.people}
            onChange={ids => updateDraft({ peopleIds: ids })}
            onAdd={() => addEntity('peopleIds', onAdd.person, 'person')}
          />
          <EntityPicker
            label="Places"
            ids={draft.placeIds}
            items={data.places}
            onChange={ids => updateDraft({ placeIds: ids })}
            onAdd={() => addEntity('placeIds', onAdd.place, 'place')}
          />
          <EntityPicker
            label="Tags"
            ids={draft.tagIds}
            items={data.tags}
            onChange={ids => updateDraft({ tagIds: ids })}
            onAdd={() => addEntity('tagIds', onAdd.tag, 'tag')}
          />
        </div>
        {suggestedPlace && (
          <div className="memory-place-suggestion">
            <span>These photos are associated with <strong>{suggestedPlace.name}</strong>. Add this Place to the memory?</span>
            <button type="button" className="quiet" onClick={() => updateDraft({ placeIds: [...new Set([...draft.placeIds, suggestedPlace.id])] })}>Add Place</button>
          </div>
        )}
        <AttachmentPanel mediaIds={draft.mediaIds} onChange={ids => updateDraft({ mediaIds: ids })}/>
        <MemoryAssistant entry={draft} data={data} onApply={async next => {
          if (!isNew) await saveDraft()
          session.current.segment++; session.current.source = 'assistantAccepted'
          setDraft(next)
        }} onAddTag={onAdd.tag} onReviewDate={!isNew && onReviewDate ? () => void finish(() => onReviewDate(latest.current)) : undefined}/>
        <div className="editor-actions">
          {!isNew && <button type="button" className="danger" onClick={() => void finish(() => onDelete(latest.current))}>Delete</button>}
          {!isNew && onHistory && <button type="button" className="quiet" onClick={() => void finish(() => onHistory(latest.current))}>History</button>}
          <span/>
          <button type="button" className="quiet" onClick={() => void finish(onClose)}>Close</button>
          <button className="primary">Save memory</button>
        </div>
      </form>
    </div>
  )
}

function EventDateFields({ eventDate, onChange }: {
  eventDate: EventDate
  onChange: (patch: Partial<EventDate>) => void
}) {
  // Keep a captured approximate year editable at its original granularity.
  // Clearing/typing the field must not switch it into an exact-date control.
  const [approximateYear] = useState(() => eventDate.precision === 'approximate' && /^\d{4}$/.test(eventDate.start ?? ''))
  if (eventDate.precision === 'approximate' && approximateYear) {
    return <label>Approximate year<input type="number" min="1000" max="9999" value={eventDate.start ?? ''} onChange={event => onChange({ start: event.target.value || undefined })}/></label>
  }
  if (eventDate.precision === 'unknown') return null
  if (eventDate.precision === 'age') {
    return <label>Age<input type="number" min="0" value={eventDate.age ?? ''} onChange={event => onChange({ age: event.target.value ? Number(event.target.value) : undefined })}/></label>
  }
  if (eventDate.precision === 'season') {
    return (
      <>
        <label>Season<select value={eventDate.season ?? 'Spring'} onChange={event => onChange({ season: event.target.value as EventDate['season'] })}>{['Spring', 'Summer', 'Autumn', 'Winter'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Year<input type="number" min="1000" max="9999" value={eventDate.start?.slice(0, 4) ?? ''} onChange={event => onChange({ start: event.target.value ? `${event.target.value.padStart(4, '0')}-01-01` : undefined })}/></label>
      </>
    )
  }
  if (eventDate.precision === 'range') {
    return (
      <>
        <label>Start date<input type="date" value={eventDate.start?.slice(0, 10) ?? ''} onChange={event => onChange({ start: event.target.value || undefined })}/></label>
        <label>End date<input type="date" value={eventDate.end?.slice(0, 10) ?? ''} onChange={event => onChange({ end: event.target.value || undefined })}/></label>
      </>
    )
  }
  if (eventDate.precision === 'month') {
    return <label>Month<input type="month" value={eventDate.start?.slice(0, 7) ?? ''} onChange={event => onChange({ start: event.target.value ? `${event.target.value}-01` : undefined })}/></label>
  }
  if (eventDate.precision === 'year') {
    return <label>Year<input type="number" min="1000" max="9999" value={eventDate.start?.slice(0, 4) ?? ''} onChange={event => onChange({ start: event.target.value ? `${event.target.value.padStart(4, '0')}-01-01` : undefined })}/></label>
  }
  return <label>Date<input type="date" value={eventDate.start?.slice(0, 10) ?? ''} onChange={event => onChange({ start: event.target.value || undefined })}/></label>
}

function EntityPicker({ label, ids, items, onChange, onAdd }: {
  label: string
  ids: string[]
  items: { id: string; name: string }[]
  onChange: (ids: string[]) => void
  onAdd: () => void
}) {
  return (
    <label>
      {label} <button type="button" className="text-button" onClick={onAdd}>add</button>
      <select
        multiple
        value={ids}
        onChange={event => onChange(Array.from(event.target.selectedOptions).map(option => option.value))}
      >
        {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
  )
}
