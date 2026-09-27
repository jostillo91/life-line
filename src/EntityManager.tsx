import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { chronologicalEras, hasDuplicateTag, referencesFor } from './domain'
import { mapFocusForPlace } from './lifeMapDomain'
import { preparePlaceForSave } from './placeEditing'
import type { Archive, LifeEra, Media, Person, Place, Tag } from './types'
import { useMediaUrl } from './useMediaUrl'

const PlaceLocationFields = lazy(() => import('./PlaceLocationFields').then(module => ({ default: module.PlaceLocationFields })))
type Kind = 'people' | 'places' | 'tags' | 'eras'
type Entity = Person | Place | Tag | LifeEra
const uid = () => crypto.randomUUID()

export function EntityManager({ kind, data, onSave, onDelete, onOpenEntries, onPlaceSuggestions, onViewOnMap, focusedPlace }: {
  kind: string
  data: Archive
  onSave: (kind: Kind, item: Entity) => Promise<void>
  onDelete: (kind: Kind, item: Entity) => void
  onOpenEntries: (field: 'peopleIds' | 'placeIds' | 'tagIds', id: string) => void
  onPlaceSuggestions?: () => void
  onViewOnMap?: (place: Place) => void
  focusedPlace?: { id: string; nonce: number }
}) {
  const entityKind = kind as Kind
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Entity | null>(null)
  const config = {
    people: { title: 'People', field: 'peopleIds', items: data.people },
    places: { title: 'Places', field: 'placeIds', items: data.places },
    tags: { title: 'Tags', field: 'tagIds', items: data.tags },
    eras: { title: 'Life eras', field: null, items: chronologicalEras(data.eras) },
  }[entityKind] as { title: string; field: 'peopleIds' | 'placeIds' | 'tagIds' | null; items: Entity[] }
  const items = useMemo(() => config.items.filter(item => `${item.name} ${'description' in item ? item.description ?? '' : ''}`.toLowerCase().includes(search.toLowerCase())), [config.items, search])
  useEffect(() => {
    if (entityKind !== 'places' || !focusedPlace) return
    const place = data.places.find(item => item.id === focusedPlace.id)
    if (place) { setSearch(place.name); setEditing(place) }
  }, [focusedPlace?.nonce])

  const create = () => setEditing(entityKind === 'people'
    ? { id: uid(), name: '', relationship: '', notes: '' }
    : entityKind === 'places' ? { id: uid(), name: '', description: '' }
      : entityKind === 'tags' ? { id: uid(), name: '', color: '#5d7fa3' }
        : { id: uid(), name: '', description: '' })

  return <section className="manager">
    <div className="manager-head"><div><span className="eyebrow">LIFE DATA</span><h2>{config.title}</h2></div><div className="manager-actions">{entityKind === 'places' && onPlaceSuggestions && <button className="quiet" onClick={onPlaceSuggestions}>Place Suggestions</button>}<button className="primary" onClick={create}>+ Add {entityKind === 'eras' ? 'era' : entityKind.slice(0, -1)}</button></div></div>
    <input className="manager-search" placeholder={`Search ${config.title.toLowerCase()}…`} value={search} onChange={event => setSearch(event.target.value)}/>
    <div className="entity-list">{items.map(item => {
      const count = config.field ? referencesFor(data.entries, config.field, item.id).length : 0
      return <article key={item.id}><div className="entity-main"><h3>{item.name}</h3>{'nickname' in item && item.nickname && <p>{item.nickname}</p>}{'description' in item && item.description && <p>{item.description}</p>}{'start' in item && <p>{item.start?.slice(0, 4) ?? 'Undated'} {item.end && `– ${item.end.slice(0, 4)}`}</p>}{entityKind === 'places' && <PlaceArchiveSummary place={item as Place} media={data.media ?? []}/>}</div><div className="entity-actions">{config.field && <button className="quiet" onClick={() => onOpenEntries(config.field!, item.id)}>{count} {count === 1 ? 'memory' : 'memories'}</button>}{entityKind === 'places' && onViewOnMap && mapFocusForPlace(item as Place, data.media ?? []) && <button className="quiet" onClick={() => onViewOnMap(item as Place)}>View on Life Map</button>}<button className="quiet" onClick={() => setEditing(item)}>Edit</button><button className="danger" onClick={() => onDelete(entityKind, item)}>Delete</button></div></article>
    })}{!items.length && <p className="empty">No matches yet.</p>}</div>
    {editing && <EntityDialog kind={entityKind} value={editing} onClose={() => setEditing(null)} onSave={async item => {
      if (entityKind === 'tags' && hasDuplicateTag(data.tags, item.name, item.id)) { alert('A tag with that name already exists.'); return }
      await onSave(entityKind, item)
      setEditing(null)
    }}/>}
  </section>
}

function EntityDialog({ kind, value, onClose, onSave }: { kind: Kind; value: Entity; onClose: () => void; onSave: (value: Entity) => Promise<void> }) {
  const [item, setItem] = useState(value)
  const [error, setError] = useState('')
  const set = (key: string, value: string) => setItem(current => ({ ...current, [key]: value }))
  const setNumber = (key: 'latitude' | 'longitude', value: string) => setItem(current => ({ ...current, [key]: value === '' ? undefined : Number(value) }))

  async function submit() {
    if (!item.name.trim()) return
    try {
      const ready = kind === 'places' ? preparePlaceForSave(value as Place, item as Place) : { ...item, name: item.name.trim() }
      setError('')
      await onSave(ready)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save this item.') }
  }

  return <div className="overlay"><form className="editor compact" onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="editor-head"><span className="eyebrow">{value.name ? 'EDIT' : 'NEW'} {kind.slice(0, -1).toUpperCase()}</span><button type="button" className="close" onClick={onClose}>×</button></div>
    <label>Name<input autoFocus value={item.name} onChange={event => set('name', event.target.value)} required/></label>
    {kind === 'people' && <><label>Nickname<input value={(item as Person).nickname ?? ''} onChange={event => set('nickname', event.target.value)}/></label><label>Relationship<input value={(item as Person).relationship ?? ''} onChange={event => set('relationship', event.target.value)}/></label></>}
    {kind === 'places' && <><label>Description<textarea value={(item as Place).description ?? ''} onChange={event => set('description', event.target.value)}/></label><Suspense fallback={<p>Loading map tools…</p>}><PlaceLocationFields place={item as Place} onCoordinate={setNumber} onAddress={value => set('address', value)}/></Suspense></>}
    {kind === 'tags' && <label>Color<input type="color" value={(item as Tag).color} onChange={event => set('color', event.target.value)}/></label>}
    {kind === 'eras' && <><label>Start<input type="date" value={(item as LifeEra).start ?? ''} onChange={event => set('start', event.target.value)}/></label><label>End<input type="date" value={(item as LifeEra).end ?? ''} onChange={event => set('end', event.target.value)}/></label><label>Description<textarea value={(item as LifeEra).description ?? ''} onChange={event => set('description', event.target.value)}/></label></>}
    {error && <p className="archive-error" role="alert">{error}</p>}
    <div className="editor-actions"><span/><button type="button" className="quiet" onClick={onClose}>Cancel</button><button className="primary">Save</button></div>
  </form></div>
}

function PlaceArchiveSummary({ place, media }: { place: Place; media: Media[] }) {
  const associated = media.filter(item => item.placeId === place.id)
  const dated = associated.map(item => item.captureDate?.slice(0, 10)).filter((date): date is string => Boolean(date)).sort()
  const images = associated.filter(item => item.mediaType === 'image').slice(0, 3)
  return <div className="place-archive-summary">{place.latitude !== undefined && place.longitude !== undefined && <small>Approx. {place.latitude.toFixed(3)}, {place.longitude.toFixed(3)}</small>}{place.address && <small>{place.address}</small>}<small>{associated.length} associated {associated.length === 1 ? 'media item' : 'media items'}{dated.length ? ` · ${dated[0]}${dated.at(-1) !== dated[0] ? ` – ${dated.at(-1)}` : ''}` : ''}</small>{images.length > 0 && <div className="place-thumbnails">{images.map(item => <PlaceThumbnail key={item.id} media={item}/>)}</div>}</div>
}
function PlaceThumbnail({ media }: { media: Media }) {
  const preview = useMediaUrl(media, 'thumbnail', true)
  return <span>{preview.url ? <img src={preview.url} alt=""/> : 'Photo'}</span>
}
