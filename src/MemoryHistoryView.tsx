import { useEffect, useState } from 'react'
import { dateLabel } from './date'
import { bodyLineDiff, changedMemoryFields, prepareRevisionRestore, revisionFieldLabels, revisionFields, revisionSourceLabels } from './memoryRevisionDomain'
import { memoryHistory, restoreMemoryRevision } from './memoryRevisionService'
import type { Archive, Entry, MemoryRevision } from './types'

const PAGE_SIZE = 20
const timestamp = (value:string) => new Date(value).toLocaleString()
export function MemoryHistoryView({ memoryId, data, onChanged, onClose }: { memoryId:string; data:Archive; onChanged:()=>Promise<void>; onClose:()=>void }) {
  const [page, setPage] = useState<{revisions:MemoryRevision[];total:number}>()
  const [offset, setOffset] = useState(0)
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<MemoryRevision>()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const current = data.entries.find(entry => entry.id === memoryId)
  useEffect(() => {
    let active = true
    setPage(undefined); setError('')
    memoryHistory(memoryId, offset, PAGE_SIZE).then(result => { if (active) setPage(result) }).catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not load history.') })
    return () => { active = false }
  }, [memoryId, offset, reload])
  const warnings = current && selected ? prepareRevisionRestore(current, selected.snapshot, data).warnings : []
  async function restore() {
    if (!selected || busy) return
    setBusy(true); setError('')
    try {
      const result = await restoreMemoryRevision(memoryId, selected.id)
      await onChanged()
      setMessage(`Version restored. Newer history is still available.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`)
      setConfirming(false); setOffset(0); setReload(value => value + 1)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not restore this version.') }
    finally { setBusy(false) }
  }
  return <div className="overlay">
    <section className="editor memory-history" role="dialog" aria-modal="true" aria-labelledby="memory-history-title">
      <div className="editor-head"><div><span className="eyebrow">LOCAL · DURABLE HISTORY</span><h2 id="memory-history-title">Memory History</h2><p>{current?.title ?? 'Unavailable memory'}</p></div><button className="close" aria-label="Close history" disabled={busy} onClick={onClose}>×</button></div>
      <p>Previous saved states, newest first. Viewing a version does not change your memory.</p>
      {error && <p className="history-warning" role="alert">{error}</p>}
      {message && <p className="history-message" role="status">{message}</p>}
      {!current && <p className="history-warning">This memory was deleted. Its history is retained in backups; restoring deleted memories is not available here.</p>}
      <div className="history-layout">
        <aside className="history-list" aria-label="Previous versions">
          {!page && !error && <p>Loading history…</p>}
          {page?.total === 0 && <p>No previous versions yet. History begins with the first meaningful change to a saved memory.</p>}
          {page && <p>{page.total} previous {page.total === 1 ? 'version' : 'versions'}</p>}
          {page?.revisions.map(revision => <button className={`history-item ${selected?.id === revision.id ? 'active' : ''}`} key={revision.id} aria-pressed={selected?.id === revision.id} disabled={busy} onClick={() => {setSelected(revision);setConfirming(false)}}>
            <strong>{timestamp(revision.createdAt)}</strong><span>{revisionSourceLabels[revision.source]}</span><small>{revision.changedFields.length ? `${revision.changedFields.map(field => revisionFieldLabels[field as typeof revisionFields[number]]).join(', ')} changed` : 'Saved state preserved'}</small>
          </button>)}
          {page && page.total > PAGE_SIZE && <div className="history-pagination"><button className="quiet" disabled={offset === 0 || busy} onClick={() => setOffset(value => Math.max(0,value-PAGE_SIZE))}>Newer</button><span>{offset+1}–{Math.min(offset+PAGE_SIZE,page.total)}</span><button className="quiet" disabled={offset+PAGE_SIZE >= page.total || busy} onClick={() => setOffset(value => value+PAGE_SIZE)}>Older</button></div>}
        </aside>
        <div className="history-content">
          {selected && current ? <>
            <RevisionComparison historical={selected.snapshot} current={current} capturedAt={selected.createdAt} data={data}/>
            {warnings.length > 0 && <div className="history-warning"><strong>Unavailable references</strong><p>Restoration will omit these references without recreating deleted records or files.</p>{warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
            {confirming ? <div className="history-confirm" role="alertdialog" aria-labelledby="history-restore-confirm"><h3 id="history-restore-confirm">Restore this version?</h3><p>Your current version will be preserved in history first. All newer history remains available. Original memory identity and creation time stay unchanged.</p><button className="quiet" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Confirm restore'}</button></div>
              : <button className="primary" disabled={busy || changedMemoryFields(current, prepareRevisionRestore(current,selected.snapshot,data).restored).length === 0} onClick={() => setConfirming(true)}>Restore this version</button>}
          </> : <p className="empty">Select a previous version to compare it with the current memory.</p>}
        </div>
      </div>
    </section>
  </div>
}

export function RevisionComparison({ historical, current, capturedAt, data }: {historical:Entry;current:Entry;capturedAt:string;data:Archive}) {
  const changed = changedMemoryFields(historical,current)
  const diff = historical.body !== current.body ? bodyLineDiff(historical.body,current.body) : undefined
  return <div className="revision-comparison">
    <h3>Changed fields</h3><p>{changed.length ? changed.map(field => revisionFieldLabels[field]).join(' · ') : 'This version matches the current content.'}</p>
    <div className="revision-columns"><RevisionPreview entry={historical} heading={`Version preserved ${timestamp(capturedAt)}`} data={data}/><RevisionPreview entry={current} heading="Current version" data={data}/></div>
    {diff && <div className="history-body-diff"><h3>Story text changes</h3><p>− Earlier text · + Current text</p>{diff.map((line,index) => <div className={`diff-${line.kind}`} key={index}><span aria-label={line.kind}>{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span>{line.text || '\u00a0'}</div>)}</div>}
    {diff === null && <p>Large story: compare the full text in the two read-only versions above.</p>}
  </div>
}
export function RevisionPreview({ entry, heading, data }: {entry:Entry;heading:string;data:Archive}) {
  const refs = (ids:string[], items:{id:string;name?:string;filename?:string;title?:string}[]) => ids.map(id => { const item = items.find(item => item.id === id); return item ? item.name ?? item.title ?? item.filename ?? id : `Unavailable (${id})` }).join(' → ') || 'None'
  return <article className="revision-preview" aria-label={heading}><h3>{heading}</h3><h4>{entry.title || '(Untitled)'}</h4><p className="memory-story">{entry.body || '(No story text)'}</p><dl>
    <dt>Kind / status</dt><dd>{entry.entryType} · {entry.status}</dd>
    <dt>Date</dt><dd>{dateLabel(entry.eventDate)} · {entry.eventDate.precision} · {entry.eventDate.confidence}<pre>{JSON.stringify(entry.eventDate,null,2)}</pre></dd>
    <dt>Importance</dt><dd>{entry.importance}</dd>
    <dt>People</dt><dd>{refs(entry.peopleIds,data.people)}</dd><dt>Places</dt><dd>{refs(entry.placeIds,data.places)}</dd><dt>Tags</dt><dd>{refs(entry.tagIds,data.tags)}</dd>
    <dt>Attachments (in order)</dt><dd>{refs(entry.mediaIds,data.media ?? [])}</dd><dt>Related memories</dt><dd>{refs(entry.relatedEntryIds,data.entries)}</dd>
    <dt>Notes</dt><dd>{entry.notes || 'None'}</dd><dt>Originally created</dt><dd>{timestamp(entry.createdAt)}</dd><dt>Recorded</dt><dd>{timestamp(entry.recordTime)}</dd>
  </dl></article>
}
