import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { dateLabel } from './date'
import { mediaAlt } from './mediaPresentation'
import { ageAt, calendarDate, calendarTicks, canMoveAtZoom, centerOf, changeZoom, clusterDestination, densityBins, deriveTimelineItems, filterTimeline, jumpToEra, jumpToYear, layoutDateSpans, layoutEras, positionMemories, stepZoom, timelineExtent, viewport, ZOOM_LEVELS, type TimelineFilter, type TimelineItem, type TimelinePosition, type TimelineZoom } from './timelineLayout'
import type { Archive, Entry, LifeEra, Media, MediaType, Person, Place, Tag } from './types'
import { useMediaUrl } from './useMediaUrl'

// Like Life Map, navigation survives view switches, but not a reload or an archive backup.
const session: { focus?: number; zoom: TimelineZoom; filter: TimelineFilter } = { zoom: 'Entire Life', filter: {} }
interface Props {
  entries: Entry[]; eras: LifeEra[]; tags: Tag[]; media: Media[]; people?: Person[]; places?: Place[]
  birthDate?: string; onSaveBirthDate?: (date: string) => Promise<void>
  dragging: Entry | null; onDragMemory: (entry: Entry | null) => void
  onOpenMemory: (entry: Entry) => void; onMoveDate: (entry: Entry) => void
  onViewUnsorted?: () => void; initialPosition?: TimelinePosition; previews?: boolean
}
const timeLabel = (time: number, zoom: TimelineZoom) => new Intl.DateTimeFormat('en', {
  timeZone: 'UTC', year: 'numeric', ...(zoom === 'Months' || zoom === 'Days' ? { month: 'short' as const } : {}),
  ...(zoom === 'Days' ? { day: 'numeric' as const } : {}),
}).format(time)

export function TimelineView({ entries, eras, tags, media, people = [], places = [], birthDate, onSaveBirthDate, dragging, onDragMemory, onOpenMemory, onMoveDate, onViewUnsorted, initialPosition, previews = true }: Props) {
  const [zoom, setZoom] = useState<TimelineZoom>(() => initialPosition?.zoom ?? session.zoom)
  const [focus, setFocus] = useState<number | undefined>(() => initialPosition?.focus ?? session.focus)
  const [filter, setFilter] = useState<TimelineFilter>(() => initialPosition ? {} : session.filter)
  const [width, setWidth] = useState(1000)
  const [jump, setJump] = useState('')
  const [jumpError, setJumpError] = useState('')
  const [birthDraft, setBirthDraft] = useState(birthDate ?? '')
  const [profileMessage, setProfileMessage] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [revealed, setRevealed] = useState<TimelineItem>()
  const [page, setPage] = useState(0)
  const [unplacedPage, setUnplacedPage] = useState(0)
  const canvas = useRef<HTMLDivElement>(null)
  const pan = useRef<{ x: number; y: number; focus: number; active: boolean } | undefined>(undefined)
  const suppressClick = useRef(false)
  const extent = useMemo(() => timelineExtent(entries, eras, birthDate), [entries, eras, birthDate])
  const position = { focus: focus ?? centerOf(extent), zoom }
  const view = viewport(position, extent)
  const archive = useMemo<Archive>(() => ({ entries, eras, tags, media, people, places }), [entries, eras, tags, media, people, places])
  const filtered = useMemo(() => filterTimeline(archive, filter), [archive, filter])
  const positioned = useMemo(() => positionMemories(filtered), [filtered])
  const unplaced = useMemo(() => { const ids = new Set(positioned.map(item => item.entry.id)); return filtered.filter(entry => !ids.has(entry.id)) }, [filtered, positioned])
  const currentUnplacedPage = Math.min(unplacedPage, Math.max(0, Math.ceil(unplaced.length / 30) - 1))
  const items = useMemo(() => deriveTimelineItems(positioned, view, width, zoom, media), [positioned, view.start, view.end, width, zoom, media])
  const bands = useMemo(() => layoutEras(eras, extent, view, width), [eras, extent, view.start, view.end, width])
  const dateSpans = useMemo(() => layoutDateSpans(items, view, width), [items, view.start, view.end, width])
  const bins = useMemo(() => densityBins(positioned, extent), [positioned, extent])
  const mediaById = useMemo(() => new Map(media.map(item => [item.id, item])), [media])
  const detailed = canMoveAtZoom(zoom)
  const rowHeight = detailed ? 440 : zoom === 'Years' ? 280 : 180
  const today = Date.now(), birth = calendarDate(birthDate)
  const xOf = (time: number) => (time - view.start) / (view.end - view.start) * width
  const overview = { start: Math.min(extent.start, view.start), end: Math.max(extent.end, view.end) }
  const overviewSize = overview.end - overview.start
  const updateFilter = (patch: Partial<TimelineFilter>) => { setFilter(value => ({ ...value, ...patch })); setRevealed(undefined) }

  useEffect(() => { if (!initialPosition) { session.focus = focus; session.zoom = zoom; session.filter = filter } }, [focus, zoom, filter, initialPosition])
  useEffect(() => { setBirthDraft(birthDate ?? '') }, [birthDate])
  useEffect(() => { setRevealed(undefined) }, [entries])
  useEffect(() => {
    if (!canvas.current) return
    const element = canvas.current
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Only consume horizontal wheel gestures or explicit Shift-wheel, never vertical page scrolling.
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return
      const delta = event.shiftKey ? event.deltaY || event.deltaX : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0
      if (!delta) return
      event.preventDefault()
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1)
      setFocus(value => (value ?? centerOf(extent)) + pixels / width * (view.end - view.start))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [width, extent, view.start, view.end])

  function zoomTo(next: TimelineZoom) {
    const changed = changeZoom(position, next); setFocus(changed.focus); setZoom(changed.zoom); setRevealed(undefined)
  }
  function selectCluster(item: TimelineItem) {
    const next = clusterDestination(item, zoom)
    setFocus(next.focus); setZoom(next.zoom)
    // A bounded list also exposes same-day dense groups and uncertain spans at maximum zoom.
    setRevealed(item); setPage(0)
  }
  function jumpEra(id: string) {
    const era = eras.find(item => item.id === id), next = era && jumpToEra(era, extent)
    if (next !== undefined) { setFocus(next); setZoom('Years'); setRevealed(undefined) }
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false
    if (event.button !== 0 || (event.pointerType !== 'touch' && (event.target as HTMLElement).closest('button, article'))) return
    pan.current = { x: event.clientX, y: event.clientY, focus: position.focus, active: false }
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = pan.current
    if (!start) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    if (!start.active && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      start.active = true; suppressClick.current = true; event.currentTarget.setPointerCapture(event.pointerId)
    }
    if (start.active) { setFocus(start.focus - dx / width * (view.end - view.start)); setRevealed(undefined) }
  }
  const ticks = calendarTicks(view, width, zoom).filter(time => xOf(time) > 65 && xOf(time) < width - 65)
  const dateAge = (time: number, scale = zoom) => {
    const age = ageAt(time, birthDate)
    return `${timeLabel(time, scale)}${age !== undefined ? ` · Age ${age}` : ''}`
  }

  return <section className="timeline-area">
    <div className="timeline-heading"><div><span className="eyebrow">CHRONOLOGICAL CANVAS</span><h2>Timeline</h2></div><span>{filtered.length} / {entries.length} moments</span></div>
    <div className="timeline-controls" aria-label="Timeline navigation">
      <button className="quiet" aria-label="Zoom out" disabled={zoom === 'Entire Life'} onClick={() => zoomTo(stepZoom(zoom, -1))}>−</button>
      <label>Scale<select aria-label="Timeline scale" value={zoom} onChange={event => zoomTo(event.target.value as TimelineZoom)}>{ZOOM_LEVELS.map(level => <option key={level}>{level}</option>)}</select></label>
      <button className="quiet" aria-label="Zoom in" disabled={zoom === 'Days'} onClick={() => zoomTo(stepZoom(zoom, 1))}>+</button>
      <button className="quiet" onClick={() => { setFocus(centerOf(extent)); setZoom('Entire Life'); setRevealed(undefined) }}>Fit entire life</button>
      <button className="quiet" aria-label="Pan earlier" onClick={() => { setFocus(position.focus - (view.end - view.start) * .35); setRevealed(undefined) }}>←</button>
      <button className="quiet" aria-label="Pan later" onClick={() => { setFocus(position.focus + (view.end - view.start) * .35); setRevealed(undefined) }}>→</button>
      <button className="quiet" onClick={() => { setFocus(today); setZoom('Months'); setRevealed(undefined) }}>Today</button>
    </div>
    <p className="timeline-focus" aria-live="polite">Centered on {dateAge(position.focus, 'Days')}</p>
    <div className="timeline-jumps">
      <form onSubmit={event => { event.preventDefault(); const date = /^\d{4}$/.test(jump) ? jumpToYear(Number(jump)) : /^\d{4}-\d{2}-\d{2}$/.test(jump) ? calendarDate(jump) : undefined; if (date === undefined) setJumpError('Enter a year (2014) or date (2014-06-15).'); else { setFocus(date); setRevealed(undefined); setJumpError('') } }}>
        <label>Jump to year or date<input aria-label="Jump to year or date" value={jump} placeholder="2014 or 2014-06-15" onChange={event => setJump(event.target.value)}/></label><button className="quiet">Go</button>
      </form>
      <label>Jump to Life Era<select aria-label="Jump to Life Era" value="" onChange={event => jumpEra(event.target.value)}><option value="">Choose era…</option>{eras.filter(era => era.start || era.end).map(era => <option key={era.id} value={era.id}>{era.name}</option>)}</select></label>
    </div>
    {jumpError && <p role="alert">{jumpError}</p>}
    <details className="timeline-filter-panel"><summary>Filter memories</summary><div className="timeline-filters">
      <label>Search<input aria-label="Timeline search" value={filter.query ?? ''} onChange={event => updateFilter({ query: event.target.value })}/></label>
      {([['Person', 'personId', people], ['Place', 'placeId', places], ['Tag', 'tagId', tags], ['Life Era', 'eraId', eras]] as const).map(([label, key, values]) => <label key={key}>{label}<select aria-label={`Timeline ${label} filter`} value={filter[key] ?? ''} onChange={event => updateFilter({ [key]: event.target.value })}><option value="">All</option>{values.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>)}
      <label>Type<select value={filter.entryType ?? ''} onChange={event => updateFilter({ entryType: event.target.value as Entry['entryType'] | '' })}><option value="">All</option>{['story', 'event', 'journal', 'milestone', 'memory'].map(type => <option key={type}>{type}</option>)}</select></label>
      {(['fromYear', 'toYear'] as const).map(key => <label key={key}>{key === 'fromYear' ? 'From year' : 'Through year'}<input type="number" min="1" max="9999" value={filter[key] ?? ''} onChange={event => updateFilter({ [key]: event.target.value ? Number(event.target.value) : undefined })}/></label>)}
      <button className="quiet" onClick={() => { setFilter({}); setRevealed(undefined) }}>Clear filters</button>
    </div></details>
    {onSaveBirthDate && <details className="timeline-profile"><summary>Age display · optional birth date</summary><form onSubmit={async event => {
      event.preventDefault(); if (birthDraft && (birthDraft.length !== 10 || calendarDate(birthDraft) === undefined)) { setProfileMessage('Enter a valid birth date.'); return }
      setProfileSaving(true)
      try { await onSaveBirthDate(birthDraft); setProfileMessage(birthDraft ? 'Age display saved locally and included in backups.' : 'Age display removed.') }
      catch { setProfileMessage('Could not save the birth date. Please try again.') }
      finally { setProfileSaving(false) }
    }}><label>Birth date<input aria-label="Birth date" type="date" value={birthDraft} onChange={event => setBirthDraft(event.target.value)}/></label><button className="quiet" disabled={profileSaving}>Save age display</button><p role="status">{profileMessage || 'Optional archive metadata. Dates before birth and future plans are allowed.'}</p></form></details>}
    <div className="timeline-overview" aria-label="Archive density overview">
      <div className="timeline-histogram" aria-hidden="true">{bins.map((count, index) => <i key={index} style={{ height: `${count ? 6 + 32 * Math.log1p(count) / Math.log1p(Math.max(1, ...bins)) : 2}px`, left: `${(extent.start - overview.start) / overviewSize * 100 + index / bins.length * (extent.end - extent.start) / overviewSize * 100}%`, width: `${(extent.end - extent.start) / overviewSize * 100 / bins.length}%` }}/>)}</div>
      <div className="timeline-overview-window" aria-hidden="true" style={{ left: `${(view.start - overview.start) / overviewSize * 100}%`, width: `${(view.end - view.start) / overviewSize * 100}%` }}/>
      <input type="range" aria-label="Navigate timeline overview" min={overview.start} max={overview.end} step={86400000} value={position.focus} onChange={event => { setFocus(Number(event.target.value)); setRevealed(undefined) }}/>
    </div>
    <div className="timeline-overview-labels"><span>{timeLabel(extent.start, 'Years')}</span><span>Archive density, not importance · drag or click to navigate</span><span>{timeLabel(extent.end, 'Years')}</span></div>
    <p id="timeline-help" className="timeline-help">Pan horizontally on the background or trackpad; Shift + wheel also pans. Focus the canvas: ← / → pan, + / − zoom. Use Tab and Enter to open memories. {detailed ? 'Drag a card and drop to review its date; nothing moves until confirmed.' : 'Zoom to Months or Days for deliberate date movement.'}</p>
    <div className="timeline-era-bands" style={{ height: Math.max(1, ...bands.map(band => band.lane + 1)) * 38 }} aria-label="Life Era ranges">{bands.map(band => <div className="timeline-era-range" key={band.era.id} style={{ left: band.x, width: band.width, top: band.lane * 38 }}><button style={{ position: 'relative', left: band.labelX - band.x, width: Math.max(130, Math.min(300, band.width)), maxWidth: 'none' }} title={`${band.era.name}: ${band.era.start ?? 'open start'} – ${band.era.end ?? 'open end'}`} onClick={() => jumpEra(band.era.id)}>{band.era.name}</button></div>)}</div>
    <div ref={canvas} className={`explorable-timeline ${dragging && detailed ? 'drop-ready' : ''}`} tabIndex={0} role="region" aria-label="Explorable timeline" aria-describedby="timeline-help"
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { pan.current = undefined }} onPointerCancel={() => { pan.current = undefined }}
      onClickCapture={event => { if (suppressClick.current) { event.stopPropagation(); suppressClick.current = false } }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setFocus(position.focus + (event.key === 'ArrowLeft' ? -1 : 1) * (view.end - view.start) * .2); setRevealed(undefined) }
        if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoomTo(stepZoom(zoom, event.key === '-' ? -1 : 1)) }
      }}
      onDragOver={event => { if (detailed) event.preventDefault() }}
      onDrop={event => { if (detailed) { event.preventDefault(); if (dragging) onMoveDate(dragging) } onDragMemory(null) }}>
      <div className="timeline-axis">{ticks.map(time => <span key={time} style={{ left: xOf(time) }}>{dateAge(time, zoom === 'Years' ? 'Months' : zoom === 'Months' ? 'Days' : zoom)}</span>)}</div>
      <div className="timeline-span-tracks" style={{ height: Math.max(0, ...dateSpans.map(span => span.lane + 1)) * 30 }} aria-label="Memory date spans">{dateSpans.map(span => {
        const entry = span.item.memories[0].entry, uncertain = span.item.memories.some(memory => memory.uncertain)
        const label = span.item.kind === 'cluster' ? `${span.item.memories.length} memories · grouped period` : `${entry.title} · ${entry.eventDate.precision}`
        return <div key={span.item.id}><div className={`timeline-date-span ${uncertain ? 'uncertain' : ''} ${entry.eventDate.precision === 'approximate' ? 'approximate' : ''}`} style={{ left: span.left, width: span.width, top: span.lane * 30 + 19 }}/><span className="timeline-span-label" style={{ left: span.labelLeft, top: span.lane * 30, maxWidth: Math.min(200, width - span.labelLeft - 4) }} title={span.item.kind === 'cluster' ? label : `${label}: ${dateLabel(entry.eventDate)}`}>{label}</span></div>
      })}</div>
      <div className="timeline-surface" style={{ height: Math.max(1, ...items.map(item => item.lane + 1)) * rowHeight + 40 }}>
        {today >= view.start && today <= view.end && <div className="timeline-boundary today" style={{ left: xOf(today) }}><span>Today</span></div>}
        {birth !== undefined && birth >= view.start && birth <= view.end && <div className="timeline-boundary birth" style={{ left: xOf(birth) }}><span>Birth</span></div>}
        {today < view.end && <div className="timeline-future" style={{ left: Math.max(0, xOf(today)), width: width - Math.max(0, xOf(today)) }} aria-label="Future timeline space"/>}
        {items.map(item => {
          const entry = item.memories[0].entry, uncertain = item.memories.some(memory => memory.uncertain)
          const attached = entry.mediaIds.map(id => mediaById.get(id)).filter((value): value is Media => Boolean(value))
          const firstImage = attached.find(value => value.mediaType === 'image')
          return <div key={item.id}>
            {item.kind === 'cluster' ? <button className="timeline-cluster" style={{ left: item.x, top: item.lane * rowHeight + 34 }} onClick={() => selectCluster(item)}>
              <small>{timeLabel(item.start, zoom)} – {timeLabel(item.end, zoom)}</small><strong>{item.memories.length} memories</strong><span>{item.photoCount} photos · {item.mediaCount} media</span><small>Explore period →</small>
            </button> : <article className={`card timeline-memory ${entry.importance >= 4 ? 'important' : ''}`} style={{ left: item.x, top: item.lane * rowHeight + 34 }} draggable={detailed}
              onDragStart={event => { if (!detailed) { event.preventDefault(); return } event.dataTransfer.effectAllowed = 'move'; onDragMemory(entry) }} onDragEnd={() => onDragMemory(null)}>
              {detailed && <button className="drag-handle" aria-label={`Move ${entry.title}`} onClick={() => onMoveDate(entry)}>↔ Move date</button>}
              <button className="timeline-memory-open" onClick={() => onOpenMemory(entry)} aria-label={`Open memory: ${entry.title}`}>
                <span className="date">{dateLabel(entry.eventDate)}</span>
                {uncertain && <small className="timeline-precision">{entry.eventDate.precision === 'approximate' ? 'Approximate · soft marker, not an exact date' : `${entry.eventDate.precision} · ${entry.eventDate.confidence}`}</small>}
                {detailed && <span className="type">{entry.entryType}</span>}
                {previews && firstImage && (detailed || zoom === 'Years') && <TimelineThumbnail media={firstImage}/>}
                <h3>{entry.title}</h3>
                {detailed && <><p>{entry.body}</p><div className="chips">{entry.tagIds.map(id => <span key={id}>{tags.find(tag => tag.id === id)?.name}</span>)}</div></>}
                {entry.mediaIds.length > 0 && <MediaIndicators total={entry.mediaIds.length} media={attached}/>}
              </button>
            </article>}
          </div>
        })}
        {!items.length && <p className="timeline-empty">{positioned.length ? 'No memories in this window. Pan, jump, or fit entire life.' : 'No dated memories match. Add a memory, clear filters, or explore Unsorted Memories.'}</p>}
      </div>
    </div>
    <p className="timeline-help">Dashed spans show month/year/season/range uncertainty; soft markers show approximate dates. Seasons use northern meteorological months. Age-only and unknown dates remain unpositioned in Unsorted Memories.{onViewUnsorted && <button className="text-button" onClick={onViewUnsorted}> Open Unsorted Memories</button>}</p>
    {unplaced.length > 0 && <details className="timeline-revealed"><summary>{unplaced.length} memories without calendar placement</summary><p>Age-only, unknown, or incomplete dates are not assigned invented positions.</p>
      {unplaced.slice(currentUnplacedPage * 30, (currentUnplacedPage + 1) * 30).map(entry => <button key={entry.id} onClick={() => onOpenMemory(entry)}><strong>{entry.title}</strong><span>{dateLabel(entry.eventDate)}</span></button>)}
      <div className="timeline-controls"><button className="quiet" disabled={!currentUnplacedPage} onClick={() => setUnplacedPage(currentUnplacedPage - 1)}>Previous unplaced memories</button><span>Page {currentUnplacedPage + 1} of {Math.ceil(unplaced.length / 30)}</span><button className="quiet" disabled={(currentUnplacedPage + 1) * 30 >= unplaced.length} onClick={() => setUnplacedPage(currentUnplacedPage + 1)}>Next unplaced memories</button></div>
    </details>}
    {revealed && <section className="timeline-revealed" aria-label="Cluster memories"><div className="timeline-controls"><h3>{revealed.memories.length} memories in this period</h3><button className="quiet" onClick={() => setRevealed(undefined)}>Close period list</button></div><p>Original dates, including uncertainty, are preserved.</p>
      {revealed.memories.slice(page * 30, (page + 1) * 30).map(({ entry }) => <button key={entry.id} onClick={() => onOpenMemory(entry)}><strong>{entry.title}</strong><span>{dateLabel(entry.eventDate)}</span></button>)}
      <div className="timeline-controls"><button className="quiet" disabled={!page} onClick={() => setPage(page - 1)}>Previous memories</button><span>Page {page + 1} of {Math.ceil(revealed.memories.length / 30)}</span><button className="quiet" disabled={(page + 1) * 30 >= revealed.memories.length} onClick={() => setPage(page + 1)}>Next memories</button></div>
    </section>}
  </section>
}

function TimelineThumbnail({ media }: { media: Media }) {
  const preview = useMediaUrl(media, 'thumbnail')
  return <div className="timeline-thumbnail" aria-label={`Thumbnail: ${mediaAlt(media)}`}>{preview.url ? <img src={preview.url} alt={mediaAlt(media)} loading="lazy"/> : <span>{preview.loading ? 'Loading image…' : 'Image preview unavailable'}</span>}</div>
}
function MediaIndicators({ total, media }: { total: number; media: Media[] }) {
  const counts = media.reduce<Partial<Record<MediaType, number>>>((result, item) => { result[item.mediaType] = (result[item.mediaType] ?? 0) + 1; return result }, {})
  return <div className="media-indicators" aria-label={`${total} ${total === 1 ? 'attachment' : 'attachments'}`}><span>{total} attached</span>{([['image', 'Photo'], ['video', 'Video'], ['audio', 'Audio'], ['document', 'Document']] as const).map(([type, label]) => counts[type] ? <span key={type}>{label} {counts[type]}</span> : null)}</div>
}
