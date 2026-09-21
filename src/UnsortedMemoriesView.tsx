import type { Entry } from './types'

export function UnsortedMemoriesView({ entries, onOpenMemory, onDragMemory }: {
  entries: Entry[]
  onOpenMemory: (entry: Entry) => void
  onDragMemory: (entry: Entry | null) => void
}) {
  return (
    <section className="unsorted">
      <div>
        <span className="eyebrow">A PLACE TO RETURN TO</span>
        <h2>Unsorted memories</h2>
        <p>Drag a memory onto Timeline, then choose a date.</p>
      </div>
      <div className="unsorted-list">
        {entries.map(entry => (
          <button
            draggable
            key={entry.id}
            onDragStart={() => onDragMemory(entry)}
            onDragEnd={() => onDragMemory(null)}
            onClick={() => onOpenMemory(entry)}
          >
            <span>{entry.eventDate.precision === 'age' ? `AGE ${entry.eventDate.age ?? '?'}` : 'UNDATED'}</span>
            <strong>{entry.title}</strong>
            <small>{entry.body}</small>
          </button>
        ))}
      </div>
    </section>
  )
}
