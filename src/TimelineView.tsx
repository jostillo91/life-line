import { dateLabel } from './date'
import { chronologicalEras } from './domain'
import type { Entry, LifeEra, Tag } from './types'

export function TimelineView({ entries, eras, tags, dragging, onDragMemory, onOpenMemory, onMoveDate }: {
  entries: Entry[]
  eras: LifeEra[]
  tags: Tag[]
  dragging: Entry | null
  onDragMemory: (entry: Entry | null) => void
  onOpenMemory: (entry: Entry) => void
  onMoveDate: (entry: Entry) => void
}) {
  return (
    <section
      className="timeline-area"
      onDragOver={event => event.preventDefault()}
      onDrop={() => { if (dragging) onMoveDate(dragging); onDragMemory(null) }}
    >
      <div className="timeline-heading">
        <div><span className="eyebrow">CHRONOLOGICAL CANVAS</span><h2>Timeline</h2></div>
        <span>{dragging ? 'Drop to choose a new date' : `${entries.length} moments`}</span>
      </div>
      <div className="era-strip">
        {chronologicalEras(eras).map(era => <span key={era.id}>{era.name}</span>)}
      </div>
      <div className={'timeline ' + (dragging ? 'drop-ready' : '')}>
        {entries.map(entry => (
          <article
            className="card"
            key={entry.id}
            draggable
            onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; onDragMemory(entry) }}
            onDragEnd={() => onDragMemory(null)}
            tabIndex={0}
          >
            <button className="drag-handle" aria-label={`Move ${entry.title}`} onClick={event => { event.stopPropagation(); onMoveDate(entry) }}>↔ Move date</button>
            <div onClick={() => onOpenMemory(entry)}>
              <div className="marker"/>
              <span className="date">{dateLabel(entry.eventDate)}</span>
              <span className="type">{entry.entryType}</span>
              <h3>{entry.title}</h3>
              <p>{entry.body}</p>
              <div className="chips">{entry.tagIds.map(id => <span key={id}>{tags.find(tag => tag.id === id)?.name}</span>)}</div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
