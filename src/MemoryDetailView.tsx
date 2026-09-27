import { useState } from 'react'
import { dateLabel } from './date'
import { suggestedPlaceForMemory } from './locationDomain'
import { MemoryEditorView, type MemoryEditorViewProps } from './MemoryEditorView'
import { MemoryMediaGallery } from './MemoryMediaGallery'
import { MemoryAssistant } from './MemoryAssistant'

type MemoryDetailViewProps = Omit<MemoryEditorViewProps, 'isNew'> & { onAskPeriod?: (entry: MemoryEditorViewProps['entry']) => void; initialEditing?:boolean }

export function MemoryDetailView(props: MemoryDetailViewProps) {
  const [editing, setEditing] = useState(props.initialEditing ?? false)
  const { entry, data, onClose, onDelete, onPersist } = props
  const [placeSuggestionHandled, setPlaceSuggestionHandled] = useState(false)

  if (editing) return <MemoryEditorView {...props} isNew={false}/>

  const people = entry.peopleIds.map(id => data.people.find(item => item.id === id)?.name).filter(isName)
  const places = entry.placeIds.map(id => data.places.find(item => item.id === id)?.name).filter(isName)
  const tags = entry.tagIds.map(id => data.tags.find(item => item.id === id)?.name).filter(isName)
  const suggestedPlaceId = suggestedPlaceForMemory(entry, data.media ?? [])
  const suggestedPlace = !placeSuggestionHandled && suggestedPlaceId && !entry.placeIds.includes(suggestedPlaceId)
    ? data.places.find(item => item.id === suggestedPlaceId)
    : undefined

  return (
    <div className="overlay">
      <article className="editor memory-detail-view">
        <div className="editor-head">
          <span className="eyebrow">MEMORY DETAIL</span>
          <button type="button" className="close" onClick={onClose} aria-label="Close memory">×</button>
        </div>
        <div className="memory-detail-heading">
          <span className="date">{dateLabel(entry.eventDate)}</span>
          <span className="type">{entry.entryType}</span>
          <h2>{entry.title}</h2>
          <span className="memory-certainty">{entry.eventDate.precision} · {entry.eventDate.confidence} · importance {entry.importance}</span>
        </div>
        {entry.body && <p className="memory-story">{entry.body}</p>}
        <MemoryMetadata label="People" values={people}/>
        <MemoryMetadata label="Places" values={places}/>
        <MemoryMetadata label="Tags" values={tags}/>
        {entry.relatedEntryIds.some(id=>!data.entries.some(item=>item.id===id)) && <p className="data-detail">A related memory is unavailable in normal views; it may be in Recovery Center. Restoring it makes its existing relationship usable again.</p>}
        {suggestedPlace && (
          <div className="memory-place-suggestion">
            <span>These photos are associated with <strong>{suggestedPlace.name}</strong>. Add this Place to the memory?</span>
            <button type="button" className="quiet" onClick={async () => {
              await onPersist({ ...entry, placeIds: [...new Set([...entry.placeIds, suggestedPlace.id])] }, false, {source:'relationship'})
              setPlaceSuggestionHandled(true)
            }}>Add Place</button>
          </div>
        )}
        <MemoryMediaGallery entry={entry} media={data.media ?? []}/>
        <MemoryAssistant entry={entry} data={data} onApply={next => (props.onAssistantApply ?? onPersist)(next)} onAddTag={props.onAdd.tag} onReviewDate={props.onReviewDate ? () => props.onReviewDate!(entry) : undefined}/>
        <div className="editor-actions memory-detail-actions">
          <button type="button" className="danger" onClick={() => onDelete(entry)}>Delete</button>
          {props.onHistory && <button type="button" className="quiet" onClick={() => props.onHistory!(entry)}>History</button>}
          {props.onAskPeriod && <button type="button" className="quiet" onClick={() => props.onAskPeriod?.(entry)}>Ask about this period</button>}
          <span/>
          <button type="button" className="quiet" onClick={onClose}>Close</button>
          <button type="button" className="primary" onClick={() => setEditing(true)}>Edit memory</button>
        </div>
      </article>
    </div>
  )
}

const isName = (value: string | undefined): value is string => Boolean(value)

function MemoryMetadata({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null
  return (
    <div className="memory-metadata">
      <span className="eyebrow">{label}</span>
      <div className="chips">{values.map(value => <span key={value}>{value}</span>)}</div>
    </div>
  )
}
