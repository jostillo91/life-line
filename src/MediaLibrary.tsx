import { useEffect, useMemo, useState } from 'react'
import { BulkPhotoImport, type NewPhotoMemory } from './BulkPhotoImport'
import { dateLabel } from './date'
import { db } from './db'
import { mapFocusForMedia } from './lifeMapDomain'
import { coordinatesForMedia, type Coordinates } from './locationDomain'
import { mediaMatches } from './mediaDomain'
import { formatBytes, mediaAlt } from './mediaPresentation'
import { PlaceSuggestions } from './PlaceSuggestions'
import { mediaDateSourceLabel } from './photoMetadata'
import {
  deleteMediaFile,
  storageInfo,
  type MediaStorageInfo,
} from './mediaStorage'
import type { Entry, Media, MediaType, Place } from './types'
import { useMediaUrl } from './useMediaUrl'

export type MediaFilter = 'all' | MediaType | 'unused' | 'date-known' | 'date-unknown'
export type MediaPlaceFilter = 'all' | 'gps-unassigned' | 'no-gps' | `place:${string}`

const filters: MediaFilter[] = ['all', 'image', 'video', 'audio', 'document', 'unused', 'date-known', 'date-unknown']

export const mediaReferenceCount = (entries: Entry[], mediaId: string) => (
  entries.filter(entry => entry.deletedAt === undefined && entry.mediaIds.includes(mediaId)).length
)

export function filterMedia(media: Media[], entries: Entry[], query: string, filter: MediaFilter, captureYear = 'all', placeFilter: MediaPlaceFilter = 'all') {
  return media.filter(item => {
    const referenceCount = mediaReferenceCount(entries, item.id)
    const matchesFilter = filter === 'all'
      || (filter === 'unused' ? referenceCount === 0 : item.mediaType === filter)
      || (filter === 'date-known' ? Boolean(item.captureDate) : filter === 'date-unknown' ? !item.captureDate : false)
    const matchesYear = captureYear === 'all' || item.captureDate?.startsWith(captureYear)
    const hasGps = Boolean(coordinatesForMedia(item))
    const matchesPlace = placeFilter === 'all'
      || (placeFilter === 'gps-unassigned' && hasGps && !item.placeId)
      || (placeFilter === 'no-gps' && !hasGps)
      || (placeFilter.startsWith('place:') && item.placeId === placeFilter.slice(6))
    return matchesFilter && matchesYear && matchesPlace && mediaMatches(item, query)
  })
}

interface MediaLibraryProps {
  media: Media[]
  entries: Entry[]
  places: Place[]
  onChanged: () => Promise<void>
  onOpenMemory: (entry: Entry) => void
  onCreateMemory: (memory: NewPhotoMemory) => void
  onViewOnMap?: (media: Media) => void
  onViewCluster?: (coordinates: Coordinates) => void
  focusedMedia?: { id: string; nonce: number }
}

export function MediaLibrary({ media, entries, places, onChanged, onOpenMemory, onCreateMemory, onViewOnMap, onViewCluster, focusedMedia }: MediaLibraryProps) {
  const [filter, setFilter] = useState<MediaFilter>('all')
  const [query, setQuery] = useState('')
  const [captureYear, setCaptureYear] = useState('all')
  const [placeFilter, setPlaceFilter] = useState<MediaPlaceFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [placeSuggestionsOpen, setPlaceSuggestionsOpen] = useState(false)
  const [info, setInfo] = useState<MediaStorageInfo | null>(null)
  const shown = useMemo(
    () => filterMedia(media, entries, query, filter, captureYear, placeFilter),
    [media, entries, query, filter, captureYear, placeFilter],
  )
  const selected = selectedId ? media.find(item => item.id === selectedId) : undefined
  const captureYears = [...new Set(media.map(item => item.captureDate?.slice(0, 4)).filter((year): year is string => Boolean(year)))].sort().reverse()

  const refreshStorageInfo = async () => setInfo(await storageInfo())
  const refresh = async () => {
    await onChanged()
    await refreshStorageInfo()
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null)
  }, [selected, selectedId])

  useEffect(() => { if (focusedMedia) setSelectedId(focusedMedia.id) }, [focusedMedia?.nonce])

  return (
    <section className="manager media-library">
      <div className="manager-head">
        <div><span className="eyebrow">PERSONAL ARCHIVE</span><h2>Media Library</h2></div>
        <div className="manager-actions">
          <button className="quiet" onClick={() => setPlaceSuggestionsOpen(true)}>Place Suggestions</button>
          <button className="primary" onClick={() => setBulkImportOpen(true)}>Import Photos</button>
        </div>
      </div>
      <input
        className="manager-search"
        placeholder="Search filename, title, caption…"
        value={query}
        onChange={event => setQuery(event.target.value)}
      />
      <div className="filters media-filters">
        {filters.map(value => (
          <button
            className={filter === value ? 'primary' : 'quiet'}
            key={value}
            onClick={() => setFilter(value)}
          >
            {value === 'unused' ? 'Unattached' : value === 'date-known' ? 'Date known' : value === 'date-unknown' ? 'Date unknown' : value}
          </button>
        ))}
        <select value={captureYear} onChange={event => setCaptureYear(event.target.value)} aria-label="Capture year">
          <option value="all">All years</option>
          {captureYears.map(year => <option key={year} value={year}>{year}</option>)}
        </select>
        <select value={placeFilter} onChange={event => setPlaceFilter(event.target.value as MediaPlaceFilter)} aria-label="Media Place">
          <option value="all">All Places</option>
          <option value="gps-unassigned">GPS without Place</option>
          <option value="no-gps">No GPS</option>
          {places.map(place => <option key={place.id} value={`place:${place.id}`}>{place.name}</option>)}
        </select>
      </div>
      <div className="media-grid">
        {shown.map(item => (
          <MediaCard
            key={item.id}
            media={item}
            count={mediaReferenceCount(entries, item.id)}
            placeName={places.find(place => place.id === item.placeId)?.name}
            onOpen={() => setSelectedId(item.id)}
          />
        ))}
      </div>
      {!shown.length && <p className="empty media-empty">No media matches this view.</p>}
      <StorageSummary info={info}/>
      {selected && (
        <MediaDetail
          media={selected}
          entries={entries.filter(entry => entry.mediaIds.includes(selected.id))}
          places={places}
          allMedia={media}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
          onOpenMemory={onOpenMemory}
          onViewOnMap={onViewOnMap}
        />
      )}
      {bulkImportOpen && (
        <BulkPhotoImport
          entries={entries}
          onChanged={refresh}
          onClose={() => setBulkImportOpen(false)}
          onCreateMemory={onCreateMemory}
          onReviewPlaces={() => { setBulkImportOpen(false); setPlaceSuggestionsOpen(true) }}
        />
      )}
      {placeSuggestionsOpen && (
        <PlaceSuggestions media={media} places={places} onChanged={refresh} onClose={() => setPlaceSuggestionsOpen(false)} onViewCluster={onViewCluster}/>
      )}
    </section>
  )
}

function MediaCard({ media, count, placeName, onOpen }: { media: Media; count: number; placeName?: string; onOpen: () => void }) {
  const preview = useMediaUrl(media, 'thumbnail', media.mediaType === 'image')

  return (
    <button className="media-card" onClick={onOpen}>
      <div className="media-card-preview">
        {media.mediaType === 'image' && preview.url
          ? <img src={preview.url} alt={mediaAlt(media)}/>
          : <span className="media-fallback">{media.mediaType === 'image' && !preview.loading ? 'Preview unavailable' : media.mediaType}</span>}
      </div>
      <strong>{media.title || media.filename}</strong>
      <small>{count} {count === 1 ? 'memory' : 'memories'} · {formatBytes(media.byteSize)}</small>
      {media.captureDate && <small>{media.captureDate.slice(0, 10)} · {mediaDateSourceLabel(media.captureDateSource)}</small>}
      {placeName && <small>Place · {placeName}</small>}
    </button>
  )
}

interface MediaDetailProps {
  media: Media
  entries: Entry[]
  places: Place[]
  allMedia?: Media[]
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenMemory: (entry: Entry) => void
  onViewOnMap?: (media: Media) => void
}

export function MediaDetail({ media, entries, places, allMedia, onClose, onChanged, onOpenMemory, onViewOnMap }: MediaDetailProps) {
  const [title, setTitle] = useState(media.title ?? '')
  const [caption, setCaption] = useState(media.caption ?? '')
  const [placeId, setPlaceId] = useState(media.placeId ?? '')
  const [status, setStatus] = useState('')
  const preview = useMediaUrl(media, 'original')

  async function saveDetails() {
    setStatus('Saving…')
    try {
      await db.media.put({ ...media, title, caption, placeId: placeId || undefined, placeSuggestionIgnored: false, version: 3 })
      await onChanged()
      setStatus('Saved')
    } catch {
      setStatus('Could not save')
    }
  }

  async function permanentlyDelete() {
    if (!confirm('Permanently delete this unattached file?')) return
    setStatus('Deleting…')
    try {
      await deleteMediaFile(media)
      onClose()
      await onChanged()
    } catch (error) {
      setStatus('')
      alert(error instanceof Error ? error.message : 'Could not delete media.')
    }
  }

  return (
    <div className="overlay">
      <section className="editor media-detail">
        <div className="editor-head">
          <span className="eyebrow">MEDIA DETAIL {status && `· ${status}`}</span>
          <button className="close" onClick={onClose} aria-label="Close media detail">×</button>
        </div>
        <h2>{media.title || media.filename}</h2>
        <MediaDetailPreview media={media} preview={preview}/>
        <div className="media-metadata">
          <label>Title<input value={title} placeholder="Title" onChange={event => setTitle(event.target.value)}/></label>
          <label>Caption<textarea value={caption} placeholder="Caption" onChange={event => setCaption(event.target.value)}/></label>
          <label>Confirmed Place<select value={placeId} onChange={event => setPlaceId(event.target.value)}>
            <option value="">No confirmed Place</option>
            {places.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}
          </select></label>
          <div className="editor-actions">
            <button className="primary" onClick={saveDetails}>Save details</button>
          </div>
        </div>
        <p className="media-file-info">{media.filename} · {media.mimeType || 'Unknown type'} · {formatBytes(media.byteSize)}</p>
        {onViewOnMap && mapFocusForMedia(media, places, allMedia) && <button className="quiet" onClick={() => { onClose(); onViewOnMap(media) }}>View on Life Map</button>}
        {(media.captureDate || media.photoMetadata) && (
          <dl className="media-capture-metadata">
            {media.captureDate && <><dt>Capture date</dt><dd>{media.captureDate.slice(0, 10)} · {media.captureDatePrecision ?? 'exact'} · {mediaDateSourceLabel(media.captureDateSource)}</dd></>}
            {!media.captureDate && media.photoMetadata?.exifOriginalDate && <><dt>EXIF date</dt><dd>{media.photoMetadata.exifOriginalDate.slice(0, 10)} · suggestion not accepted</dd></>}
            {(media.photoMetadata?.cameraMake || media.photoMetadata?.cameraModel) && <><dt>Camera</dt><dd>{[media.photoMetadata.cameraMake, media.photoMetadata.cameraModel].filter(Boolean).join(' ')}</dd></>}
            {media.photoMetadata?.latitude !== undefined && media.photoMetadata.longitude !== undefined && <><dt>GPS</dt><dd>{media.photoMetadata.latitude.toFixed(5)}, {media.photoMetadata.longitude.toFixed(5)}</dd></>}
          </dl>
        )}
        <section className="associated-memories">
          <span className="eyebrow">ASSOCIATED MEMORIES</span>
          {entries.map(entry => (
            <button key={entry.id} onClick={() => onOpenMemory(entry)}>
              <strong>{entry.title}</strong>
              <small>{dateLabel(entry.eventDate)} · {entry.entryType}</small>
            </button>
          ))}
          {!entries.length && <p className="empty">This media is not attached to a memory.</p>}
        </section>
        {entries.length > 0
          ? <p className="delete-note">Detach this media from its associated memories before permanently deleting it.</p>
          : <button className="danger permanent-delete" onClick={permanentlyDelete}>Permanently delete</button>}
      </section>
    </div>
  )
}

export function MediaDetailPreview({ media, preview }: {
  media: Media
  preview: { url?: string; loading: boolean }
}) {
  if (preview.loading) return <div className="media-detail-preview media-fallback">Loading preview…</div>
  if (!preview.url) {
    return <div className="media-detail-preview media-fallback">Preview unavailable. The stored file could not be loaded.</div>
  }
  if (media.mediaType === 'image') {
    return <div className="media-detail-preview"><img src={preview.url} alt={mediaAlt(media)}/></div>
  }
  if (media.mediaType === 'video') {
    return <div className="media-detail-preview"><video controls src={preview.url}/></div>
  }
  if (media.mediaType === 'audio') {
    return <div className="media-detail-preview audio-preview"><audio controls src={preview.url}/></div>
  }
  return (
    <div className="media-detail-preview document-preview">
      <span>Document</span>
      <a className="quiet" href={preview.url} download={media.filename}>Open or download file</a>
    </div>
  )
}

function StorageSummary({ info }: { info: MediaStorageInfo | null }) {
  if (!info) return <p className="storage-note">Checking local storage… · Browser-local media is not a durable backup.</p>

  const capacity = info.quota === undefined
    ? 'Storage quota unavailable'
    : `${formatBytes(info.quota)} estimated capacity`
  const usage = info.usage === undefined
    ? 'Storage use unavailable'
    : `${formatBytes(info.usage)} used`
  const remaining = info.usage === undefined || info.quota === undefined
    ? 'Remaining capacity unavailable'
    : `${formatBytes(Math.max(0, info.quota - info.usage))} approximately available`
  const persistence = info.persistent === undefined
    ? 'Persistent-storage status unavailable'
    : info.persistent ? 'Persistent storage granted' : 'Persistent storage not granted'

  return <p className="storage-note">{usage} · {capacity} · {remaining} · {persistence} · Browser-local media is not a durable backup.</p>
}
