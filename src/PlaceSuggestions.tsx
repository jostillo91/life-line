import { useMemo, useState } from 'react'
import { db } from './db'
import {
  assignPlaceToMedia,
  clusterNearbyMedia,
  matchPlaces,
  placeFromCluster,
  type Coordinates,
  type LocationCluster,
} from './locationDomain'
import type { Media, Place } from './types'
import { useMediaUrl } from './useMediaUrl'

export function PlaceSuggestions({ media, places, onChanged, onClose, onViewCluster }: {
  media: Media[]
  places: Place[]
  onChanged: () => Promise<void>
  onClose: () => void
  onViewCluster?: (coordinates: Coordinates) => void
}) {
  const clusters = useMemo(
    () => clusterNearbyMedia(media.filter(item => !item.placeId && !item.placeSuggestionIgnored)),
    [media],
  )
  const confirmedGroups = places
    .map(place => ({ place, media: media.filter(item => item.placeId === place.id) }))
    .filter(group => group.media.length)

  return (
    <div className="overlay place-suggestions-overlay">
      <section className="editor place-suggestions">
        <div className="editor-head">
          <div><span className="eyebrow">LOCAL GPS REVIEW</span><h2>Place Suggestions</h2></div>
          <button className="close" onClick={onClose} aria-label="Close place suggestions">×</button>
        </div>
        <p className="place-suggestions-intro">Nearby GPS-tagged photos are grouped locally. Nothing creates a Place or changes a memory until you confirm it.</p>
        <div className="place-clusters">
          {clusters.map(cluster => (
            <PlaceSuggestionCard key={cluster.id} cluster={cluster} places={places} onChanged={onChanged} onViewCluster={onViewCluster}/>
          ))}
          {!clusters.length && <p className="empty place-empty">No unreviewed GPS photo clusters remain.</p>}
        </div>
        {confirmedGroups.length > 0 && (
          <section className="confirmed-place-groups">
            <span className="eyebrow">CONFIRMED MEDIA PLACES</span>
            <p>Remove a confirmed association here without changing any memory.</p>
            {confirmedGroups.map(group => (
              <ConfirmedPlaceGroup key={group.place.id} {...group} onChanged={onChanged}/>
            ))}
          </section>
        )}
      </section>
    </div>
  )
}

function PlaceSuggestionCard({ cluster, places, onChanged, onViewCluster }: {
  cluster: LocationCluster
  places: Place[]
  onChanged: () => Promise<void>
  onViewCluster?: (coordinates: Coordinates) => void
}) {
  const match = useMemo(() => matchPlaces(cluster.center, places), [cluster.center, places])
  const [selectedIds, setSelectedIds] = useState(() => new Set(cluster.media.map(item => item.id)))
  const [placeId, setPlaceId] = useState(match.suggested?.place.id ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState('')
  const representative = cluster.media.find(item => item.mediaType === 'image') ?? cluster.media[0]

  const toggle = (id: string) => setSelectedIds(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  async function assignExisting() {
    if (!placeId || !selectedIds.size) return
    setStatus('Saving…')
    const updates = assignPlaceToMedia(cluster.media, [...selectedIds], placeId)
      .filter(item => selectedIds.has(item.id))
    await db.media.bulkPut(updates)
    await onChanged()
  }

  async function createPlace() {
    if (!name.trim() || !selectedIds.size) return
    setStatus('Saving…')
    const place = placeFromCluster(cluster, name, description)
    const updates = assignPlaceToMedia(cluster.media, [...selectedIds], place.id)
      .filter(item => selectedIds.has(item.id))
    await db.transaction('rw', [db.places, db.media], async () => {
      await db.places.put(place)
      await db.media.bulkPut(updates)
    })
    await onChanged()
  }

  async function ignoreCluster() {
    setStatus('Ignoring…')
    await db.media.bulkPut(cluster.media.map(item => ({ ...item, placeSuggestionIgnored: true, version: 3 as const })))
    await onChanged()
  }

  return (
    <article className="place-cluster-card">
      <div className="cluster-summary">
        <ClusterPreview media={representative}/>
        <div>
          <span className="cluster-status">Unassigned suggestion {status && `· ${status}`}</span>
          <h3>{cluster.media.length} {cluster.media.length === 1 ? 'photo' : 'photos'} near one location</h3>
          <p>{formatCoordinates(cluster.center.latitude, cluster.center.longitude)} · {formatCaptureRange(cluster)}</p>
          <PlaceMatchMessage match={match}/>
        </div>
      </div>
      <div className="cluster-media-list">
        {cluster.media.map(item => (
          <label key={item.id}>
            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggle(item.id)}/>
            <ClusterMediaThumb media={item}/>
            <span><strong>{item.title || item.filename}</strong><small>{item.captureDate?.slice(0, 10) ?? 'Capture date unknown'}</small></span>
          </label>
        ))}
      </div>
      {onViewCluster && <button className="quiet" onClick={() => onViewCluster(cluster.center)}>View cluster on Life Map</button>}
      <div className="cluster-selection-actions">
        <button className="text-button" onClick={() => setSelectedIds(new Set(cluster.media.map(item => item.id)))}>Select all</button>
        <button className="text-button" onClick={() => setSelectedIds(new Set())}>Select none</button>
        <span>{selectedIds.size} selected</span>
      </div>
      <div className="place-assignment-actions">
        <label>Existing Place<select value={placeId} onChange={event => setPlaceId(event.target.value)}>
          <option value="">Choose a Place…</option>
          {places.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}
        </select></label>
        <button className="primary" disabled={!placeId || !selectedIds.size} onClick={assignExisting}>Assign selected</button>
      </div>
      <div className="new-place-actions">
        <label>New Place name<input value={name} required placeholder="Grandma's House" onChange={event => setName(event.target.value)}/></label>
        <label>Description (optional)<input value={description} onChange={event => setDescription(event.target.value)}/></label>
        <button className="primary" disabled={!name.trim() || !selectedIds.size} onClick={createPlace}>Create and assign</button>
        <button className="quiet" onClick={ignoreCluster}>Ignore cluster</button>
      </div>
    </article>
  )
}

function PlaceMatchMessage({ match }: { match: ReturnType<typeof matchPlaces> }) {
  if (match.suggested) {
    return <p className="place-match">This may be <strong>{match.suggested.place.name}</strong> · about {formatDistance(match.suggested.distanceMeters)} away</p>
  }
  if (match.ambiguous) {
    return <p className="place-match">Several Places are nearby: {match.candidates.map(item => item.place.name).join(', ')}. Choose one to confirm.</p>
  }
  return <p className="place-match">No existing Place is close enough for a conservative suggestion.</p>
}

function ConfirmedPlaceGroup({ place, media, onChanged }: {
  place: Place
  media: Media[]
  onChanged: () => Promise<void>
}) {
  const [selected, setSelected] = useState(() => new Set(media.map(item => item.id)))

  async function removeSelected() {
    if (!selected.size) return
    const updates = assignPlaceToMedia(media, [...selected], undefined).filter(item => selected.has(item.id))
    await db.media.bulkPut(updates)
    await onChanged()
  }

  return (
    <details className="confirmed-place-group">
      <summary>{place.name} — {media.length} {media.length === 1 ? 'photo' : 'photos'}</summary>
      <div className="confirmed-place-list">
        {media.map(item => (
          <label key={item.id}>
            <input type="checkbox" checked={selected.has(item.id)} onChange={() => setSelected(current => {
              const next = new Set(current)
              if (next.has(item.id)) next.delete(item.id)
              else next.add(item.id)
              return next
            })}/>
            <span>{item.title || item.filename}</span>
          </label>
        ))}
      </div>
      <button className="quiet" disabled={!selected.size} onClick={removeSelected}>Remove Place from selected</button>
    </details>
  )
}

function ClusterPreview({ media }: { media: Media }) {
  const preview = useMediaUrl(media, 'thumbnail', media.mediaType === 'image')
  return <div className="cluster-preview">{preview.url ? <img src={preview.url} alt=""/> : <span>GPS</span>}</div>
}

function ClusterMediaThumb({ media }: { media: Media }) {
  const preview = useMediaUrl(media, 'thumbnail', media.mediaType === 'image')
  return <span className="cluster-media-thumb">{preview.url ? <img src={preview.url} alt=""/> : 'Photo'}</span>
}

function formatCoordinates(latitude: number, longitude: number) {
  return `Approx. ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`
}

function formatCaptureRange(cluster: LocationCluster) {
  if (!cluster.captureStart) return 'Capture dates unknown'
  if (!cluster.captureEnd || cluster.captureStart === cluster.captureEnd) return cluster.captureStart
  return `${cluster.captureStart} – ${cluster.captureEnd}`
}

function formatDistance(distance: number) {
  return distance < 1_000 ? `${Math.round(distance)} m` : `${(distance / 1_000).toFixed(1)} km`
}
