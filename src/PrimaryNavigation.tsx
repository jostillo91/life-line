export type View = 'timeline' | 'unsorted' | 'people' | 'places' | 'tags' | 'eras'

const items: Array<[View, string]> = [
  ['timeline', 'Timeline'],
  ['unsorted', 'Unsorted Memories'],
  ['people', 'People'],
  ['places', 'Places'],
  ['tags', 'Tags'],
  ['eras', 'Life Eras'],
]

export function PrimaryNavigation({ currentView, onViewChange }: {
  currentView: View
  onViewChange: (view: View) => void
}) {
  return (
    <nav className="nav">
      {items.map(([id, label]) => (
        <button
          key={id}
          className={currentView === id ? 'active' : ''}
          onClick={() => onViewChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
