import { useEffect, useMemo, useState } from 'react'
import { dateLabel } from './date'
import { saveMemory } from './memoryRevisionService'
import { formatBytes } from './mediaPresentation'
import {
  contentHashFor,
  createImageThumbnail,
  findMediaByContentHash,
  importMediaFile,
  storageInfo,
} from './mediaStorage'
import { attachImportedMedia, eventDateForPhotos, photoGroupLabel, type ConfirmedPhotoDate } from './photoImportDomain'
import { extractPhotoMetadata, suggestPhotoDate } from './photoMetadata'
import type {
  EventDate,
  Entry,
  MediaDateConfidence,
  MediaDateSource,
  PhotoMetadata,
} from './types'

type ImportState = 'analyzing' | 'ready' | 'duplicate' | 'importing' | 'imported' | 'failed'

interface ImportQueueItem {
  id: string
  file: File
  selected: boolean
  state: ImportState
  error?: string
  contentHash?: string
  existingMediaId?: string
  mediaId?: string
  metadata?: PhotoMetadata
  date?: string
  dateSource?: MediaDateSource
  dateConfidence?: MediaDateConfidence
  dateLabel: string
  dateAccepted: boolean
  precision: 'exact' | 'month' | 'year' | 'approximate'
}

export interface NewPhotoMemory {
  mediaIds: string[]
  eventDate: EventDate
  title: string
}

export function BulkPhotoImport({ entries, onChanged, onClose, onCreateMemory, onReviewPlaces }: {
  entries: Entry[]
  onChanged: () => Promise<void>
  onClose: () => void
  onCreateMemory: (memory: NewPhotoMemory) => void
  onReviewPlaces: () => void
}) {
  const [queue, setQueue] = useState<ImportQueueItem[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [bulkDate, setBulkDate] = useState('')
  const [bulkPrecision, setBulkPrecision] = useState<ImportQueueItem['precision']>('exact')
  const [targetEntryId, setTargetEntryId] = useState('')
  const [capacityWarning, setCapacityWarning] = useState('')

  const selected = queue.filter(item => item.selected)
  const grouped = useMemo(() => {
    const groups = new Map<string, ImportQueueItem[]>()
    for (const item of queue) {
      const label = photoGroupLabel(item.date)
      groups.set(label, [...(groups.get(label) ?? []), item])
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [queue])
  const relationshipMediaIds = [...new Set(queue
    .filter(item => item.selected && (item.state === 'imported' || item.state === 'duplicate'))
    .map(item => item.mediaId ?? item.existingMediaId)
    .filter((id): id is string => Boolean(id)))]
  const relationshipHasLocation = queue.some(item => (
    item.selected
    && (item.state === 'imported' || item.state === 'duplicate')
    && item.metadata?.latitude !== undefined
    && item.metadata.longitude !== undefined
  ))

  useEffect(() => {
    const selectedBytes = selected
      .filter(item => item.state !== 'duplicate' && item.state !== 'imported')
      .reduce((total, item) => total + item.file.size, 0)
    storageInfo().then(info => {
      if (info.quota === undefined || info.usage === undefined) setCapacityWarning('Storage capacity could not be estimated in this browser.')
      else if (selectedBytes > info.quota - info.usage) setCapacityWarning(`This selection is about ${formatBytes(selectedBytes)}, which may exceed the estimated remaining browser storage.`)
      else setCapacityWarning('')
    })
  }, [queue])

  async function addFiles(files: FileList | File[]) {
    const images = Array.from(files).filter(file => file.type.startsWith('image/'))
    const additions = images.map<ImportQueueItem>(file => ({
      id: crypto.randomUUID(),
      file,
      selected: true,
      state: 'analyzing',
      dateLabel: 'Reading metadata…',
      dateAccepted: false,
      precision: 'exact',
    }))
    setQueue(current => [...current, ...additions])

    await processWithConcurrency(additions, 4, async item => {
      try {
        const [metadata, contentHash] = await Promise.all([
          extractPhotoMetadata(item.file),
          contentHashFor(item.file),
        ])
        const existing = await findMediaByContentHash(contentHash)
        const suggestion = suggestPhotoDate(item.file.name, metadata)
        update(item.id, {
          metadata,
          contentHash,
          existingMediaId: existing?.id,
          state: existing ? 'duplicate' : 'ready',
          date: suggestion.date,
          dateSource: suggestion.source,
          dateConfidence: suggestion.confidence,
          dateLabel: suggestion.label,
        })
      } catch (error) {
        update(item.id, { state: 'failed', error: message(error), dateLabel: 'Metadata unavailable' })
      }
    })
  }

  function update(id: string, patch: Partial<ImportQueueItem>) {
    setQueue(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
  }

  function updateSelected(patch: Partial<ImportQueueItem>) {
    setQueue(current => current.map(item => item.selected ? { ...item, ...patch } : item))
  }

  async function importSelected() {
    const targets = queue.filter(item => item.selected && ['ready', 'failed'].includes(item.state))
    setProgress({ completed: 0, total: targets.length })
    let completed = 0
    for (const item of targets) {
      update(item.id, { state: 'importing', error: undefined })
      try {
        const result = await importMediaFile(item.file, {
          contentHash: item.contentHash,
          captureDate: item.dateAccepted ? item.date : undefined,
          captureDateSource: item.dateAccepted ? item.dateSource : undefined,
          captureDateConfidence: item.dateAccepted ? item.dateConfidence : undefined,
          captureDatePrecision: item.dateAccepted ? item.precision : undefined,
          photoMetadata: item.metadata,
        })
        if (!result.duplicate) {
          try { await createImageThumbnail(result.media) } catch { /* Original remains safely imported. */ }
        }
        update(item.id, {
          state: result.duplicate ? 'duplicate' : 'imported',
          mediaId: result.media.id,
          existingMediaId: result.duplicate ? result.media.id : undefined,
        })
      } catch (error) {
        update(item.id, { state: 'failed', error: message(error) })
      }
      completed += 1
      setProgress({ completed, total: targets.length })
    }
    await onChanged()
  }

  async function attachToExisting() {
    const entry = entries.find(item => item.id === targetEntryId)
    if (!entry || !relationshipMediaIds.length) return
    await saveMemory(attachImportedMedia(entry, relationshipMediaIds), {source:'media'})
    await onChanged()
    setTargetEntryId('')
  }

  function createMemory() {
    if (!relationshipMediaIds.length) return
    const confirmedDates = queue
      .filter(item => item.selected && item.dateAccepted && item.date && (item.mediaId || item.existingMediaId))
      .map<ConfirmedPhotoDate>(item => ({ date: item.date!, precision: item.precision }))
    const eventDate = eventDateForPhotos(confirmedDates)
    onCreateMemory({ mediaIds: relationshipMediaIds, eventDate, title: dateLabel(eventDate) === 'Unsorted memory' ? 'Photo memory' : dateLabel(eventDate) })
    onClose()
  }

  return (
    <div className="overlay bulk-import-overlay">
      <section
        className="editor bulk-import"
        onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); void addFiles(event.dataTransfer.files) }}
      >
        <div className="editor-head">
          <div><span className="eyebrow">LOCAL PHOTO WORKFLOW</span><h2>Bulk Photo Import</h2></div>
          <button className="close" onClick={onClose} aria-label="Close bulk photo import">×</button>
        </div>
        <p className="bulk-import-intro">Choose images, review date suggestions, then import. Suggested dates never change a memory unless you explicitly create or edit one.</p>
        <label className="bulk-dropzone">
          <strong>Select photos</strong>
          <span>or drag and drop image files here</span>
          <input type="file" accept="image/*" multiple onChange={event => event.target.files && void addFiles(event.target.files)}/>
        </label>
        {capacityWarning && <p className="capacity-warning">{capacityWarning}</p>}
        {queue.length > 0 && (
          <>
            <div className="bulk-actions">
              <button className="quiet" onClick={() => setQueue(current => current.map(item => item.selected && item.date ? { ...item, dateAccepted: true } : item))}>Accept selected suggestions</button>
              <button className="quiet" onClick={() => setQueue(current => current.map(item => item.selected && item.dateConfidence === 'high' && ['exif-original', 'exif-created'].includes(item.dateSource ?? '') ? { ...item, dateAccepted: true } : item))}>Accept high-confidence EXIF</button>
              <button className="quiet" onClick={() => updateSelected({ precision: 'approximate', dateAccepted: true })}>Mark approximate</button>
              <button className="quiet" onClick={() => updateSelected({ date: undefined, dateAccepted: false, dateSource: undefined, dateConfidence: undefined, dateLabel: 'No date selected' })}>Clear selected dates</button>
            </div>
            <div className="bulk-date-action">
              <label>Same date<input type="date" value={bulkDate} onChange={event => setBulkDate(event.target.value)}/></label>
              <label>Precision<select value={bulkPrecision} onChange={event => setBulkPrecision(event.target.value as ImportQueueItem['precision'])}>{['exact', 'month', 'year', 'approximate'].map(value => <option key={value}>{value}</option>)}</select></label>
              <button className="quiet" disabled={!bulkDate} onClick={() => updateSelected({ date: bulkDate, precision: bulkPrecision, dateAccepted: true, dateSource: 'user', dateConfidence: 'high', dateLabel: 'User confirmed' })}>Apply to selected</button>
              <button className="quiet" onClick={() => setQueue(current => current.map(item => ({ ...item, selected: true })))}>Select all</button>
              <button className="quiet" onClick={() => setQueue(current => current.map(item => ({ ...item, selected: false })))}>Select none</button>
              <button className="quiet" onClick={() => setQueue(current => current.filter(item => !item.selected))}>Remove selected</button>
            </div>
            <div className="photo-groups">
              {grouped.map(([label, items]) => (
                <details key={label} open={items.length <= 20}>
                  <summary>{label} — {items.length} {items.length === 1 ? 'photo' : 'photos'} <button className="text-button" onClick={event => { event.preventDefault(); const ids = new Set(items.map(item => item.id)); setQueue(current => current.map(item => ids.has(item.id) ? { ...item, selected: true } : item)) }}>Select group</button></summary>
                  <div className="photo-queue">{items.map(item => <QueueItem key={item.id} item={item} update={patch => update(item.id, patch)}/>)}</div>
                </details>
              ))}
            </div>
            <div className="import-progress">
              <span>{progress.total ? `${progress.completed} of ${progress.total} photos processed` : `${selected.length} selected`}</span>
              <button className="primary" disabled={!selected.some(item => ['ready', 'failed'].includes(item.state))} onClick={importSelected}>Import selected photos</button>
            </div>
          </>
        )}
        {relationshipMediaIds.length > 0 && (
          <section className="post-import-actions">
            <span className="eyebrow">TIMELINE RELATIONSHIP</span>
            <p>Imported photos remain media-only unless you choose one of these actions.</p>
            <div className="post-import-buttons">
              <button className="quiet" onClick={onClose}>Finish — media only</button>
              <button className="primary" onClick={createMemory}>Create timeline memory</button>
              {relationshipHasLocation && <button className="quiet" onClick={onReviewPlaces}>Review place suggestions</button>}
            </div>
            <div className="attach-existing">
              <select value={targetEntryId} onChange={event => setTargetEntryId(event.target.value)}>
                <option value="">Choose an existing memory…</option>
                {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
              </select>
              <button className="quiet" disabled={!targetEntryId} onClick={attachToExisting}>Add to existing memory</button>
            </div>
          </section>
        )}
      </section>
    </div>
  )
}

function QueueItem({ item, update }: { item: ImportQueueItem; update: (patch: Partial<ImportQueueItem>) => void }) {
  const [previewUrl, setPreviewUrl] = useState<string>()
  useEffect(() => {
    const url = URL.createObjectURL(item.file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [item.file])

  return (
    <article className={`photo-queue-item state-${item.state}`}>
      <input type="checkbox" checked={item.selected} onChange={event => update({ selected: event.target.checked })} aria-label={`Select ${item.file.name}`}/>
      <div className="queue-thumbnail">{previewUrl && <img src={previewUrl} alt=""/>}</div>
      <div className="queue-file">
        <strong>{item.file.name}</strong>
        <small>{formatBytes(item.file.size)} · {stateLabel(item)}</small>
        {item.metadata?.cameraMake && <small>{[item.metadata.cameraMake, item.metadata.cameraModel].filter(Boolean).join(' ')}</small>}
        {item.metadata?.latitude !== undefined && item.metadata.longitude !== undefined && <small>Location metadata found</small>}
        {item.error && <small className="queue-error">{item.error}</small>}
      </div>
      <div className="queue-date">
        <label>Date<input type="date" value={item.date ?? ''} onChange={event => update({ date: event.target.value || undefined, dateAccepted: Boolean(event.target.value), dateSource: event.target.value ? 'user' : undefined, dateConfidence: event.target.value ? 'high' : undefined, dateLabel: event.target.value ? 'User confirmed' : 'No date selected' })}/></label>
        <label>Precision<select value={item.precision} onChange={event => update({ precision: event.target.value as ImportQueueItem['precision'], dateAccepted: Boolean(item.date) })}>{['exact', 'month', 'year', 'approximate'].map(value => <option key={value}>{value}</option>)}</select></label>
        <small>{item.dateLabel}{item.dateConfidence ? ` · ${item.dateConfidence}` : ''}{item.dateAccepted ? ' · accepted' : ' · suggestion only'}</small>
        {item.date && !item.dateAccepted && <button className="text-button" onClick={() => update({ dateAccepted: true })}>Accept date</button>}
      </div>
    </article>
  )
}

function stateLabel(item: ImportQueueItem) {
  if (item.state === 'duplicate') return 'Already imported'
  if (item.state === 'analyzing') return 'Reading metadata'
  if (item.state === 'ready') return item.date ? item.dateLabel : 'No reliable date'
  if (item.state === 'importing') return 'Importing'
  if (item.state === 'imported') return 'Imported'
  return 'Failed — retry available'
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Import failed'
}

async function processWithConcurrency<T>(items: T[], limit: number, process: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await process(item)
    }
  })
  await Promise.all(workers)
}
