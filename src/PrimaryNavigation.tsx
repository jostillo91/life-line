export type View = 'timeline' | 'search' | 'unsorted' | 'people' | 'places' | 'tags' | 'eras' | 'media' | 'map' | 'data'

const items: Array<[View, string]> = [
  ['timeline', 'Timeline'],
  ['search', 'Search'],
  ['unsorted', 'Unsorted Memories'],
  ['people', 'People'],
  ['places', 'Places'],
  ['tags', 'Tags'],
  ['eras', 'Life Eras'],
  ['media', 'Media Library'],
  ['map', 'Life Map'],
  ['data', 'Backup & Restore'],
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
