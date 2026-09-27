import { matchesFilters, keywordScore, type SearchFilters } from './semanticSearch'
import type { Archive, Entry, EventDate, LifeEra } from './types'

export const DAY = 86_400_000
export const ZOOM_LEVELS = ['Entire Life', 'Decades', 'Years', 'Months', 'Days'] as const
export type TimelineZoom = typeof ZOOM_LEVELS[number]
export interface TimeSpan { start: number; end: number }
export interface TimelineFilter extends SearchFilters { query?: string }
export interface TimelinePosition { focus: number; zoom: TimelineZoom }
export interface PositionedMemory extends TimeSpan { entry: Entry; uncertain: boolean }
export interface TimelineItem extends TimeSpan {
  id: string; memories: PositionedMemory[]; kind: 'memory' | 'cluster'; x: number; lane: number
  mediaCount: number; photoCount: number
}

// Calendar arithmetic is UTC, so DST/timezone changes do not move archive dates.
export function calendarDate(value?: string): number | undefined {
  if (!value || !/^\d{4}(-\d{2})?(-\d{2})?$/.test(value)) return undefined
  const [year, month = 1, day = 1] = value.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return date.getTime()
}
const utc = (year: number, month = 0, day = 1) => {
  const date = new Date(0); date.setUTCFullYear(year, month, day); date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}
function inclusiveEnd(value?: string): number | undefined {
  const time = calendarDate(value)
  if (time === undefined) return undefined
  const date = new Date(time)
  return value!.length === 4 ? utc(date.getUTCFullYear() + 1) - 1
    : value!.length === 7 ? utc(date.getUTCFullYear(), date.getUTCMonth() + 1) - 1 : time + DAY - 1
}

export function eventSpan(date: EventDate): (TimeSpan & { uncertain: boolean }) | undefined {
  if (date.precision === 'unknown' || date.precision === 'age') return undefined
  const start = calendarDate(date.start)
  if (start === undefined) return undefined
  const year = new Date(start).getUTCFullYear(), month = new Date(start).getUTCMonth()
  switch (date.precision) {
    case 'year': return { start: utc(year), end: utc(year + 1) - 1, uncertain: true }
    case 'month': return { start: utc(year, month), end: utc(year, month + 1) - 1, uncertain: true }
    case 'season': {
      // Northern-hemisphere meteorological seasons, displayed as a convention, not an exact date.
      if (!date.season) return { start: utc(year), end: utc(year + 1) - 1, uncertain: true }
      const first = { Spring: 2, Summer: 5, Autumn: 8, Winter: 11 }[date.season]
      return { start: utc(year, first), end: utc(year, first + 3) - 1, uncertain: true }
    }
    case 'range': {
      const end = inclusiveEnd(date.end)
      if (end === undefined || end < start) return undefined
      return { start, end, uncertain: true }
    }
    default: return { start, end: inclusiveEnd(date.start)!, uncertain: date.precision === 'approximate' || date.confidence !== 'confirmed' }
  }
}

export function eraSpan(era: LifeEra, extent: TimeSpan): TimeSpan | undefined {
  const start = era.start ? calendarDate(era.start) : extent.start
  const end = era.end ? inclusiveEnd(era.end) : extent.end
  return start !== undefined && end !== undefined && end >= start ? { start, end } : undefined
}
export const centerOf = (span: TimeSpan) => span.start + (span.end - span.start) / 2
export function timelineExtent(entries: Entry[], eras: LifeEra[], birthDate?: string, today = Date.now()): TimeSpan {
  let start = today, end = today
  for (const entry of entries) {
    const span = eventSpan(entry.eventDate)
    if (span) { start = Math.min(start, span.start); end = Math.max(end, span.end) }
  }
  for (const era of eras) {
    const from = calendarDate(era.start), to = inclusiveEnd(era.end)
    if (from !== undefined) start = Math.min(start, from)
    if (to !== undefined) end = Math.max(end, to)
  }
  const birth = calendarDate(birthDate)
  if (birth !== undefined) start = Math.min(start, birth)
  const padding = Math.max(30 * DAY, (end - start) * .04)
  return { start: start - padding, end: end + padding }
}
export function zoomDuration(zoom: TimelineZoom, extent: TimeSpan) {
  const life = Math.max(365.25 * DAY, extent.end - extent.start)
  return Math.min(life, { 'Entire Life': life, Decades: 20 * 365.25 * DAY, Years: 2 * 365.25 * DAY, Months: 90 * DAY, Days: 7 * DAY }[zoom])
}
export function viewport(position: TimelinePosition, extent: TimeSpan): TimeSpan {
  const duration = zoomDuration(position.zoom, extent)
  return { start: position.focus - duration / 2, end: position.focus + duration / 2 }
}
export function changeZoom(position: TimelinePosition, zoom: TimelineZoom): TimelinePosition {
  return { ...position, zoom } // Preserve the focal instant, including when outside the original archive span.
}
export function stepZoom(zoom: TimelineZoom, step: number): TimelineZoom {
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, ZOOM_LEVELS.indexOf(zoom) + step))]
}
export function jumpToYear(year: number): number | undefined {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return undefined
  return centerOf({ start: utc(year), end: utc(year + 1) - 1 })
}
export function jumpToEra(era: LifeEra, extent: TimeSpan) { const span = eraSpan(era, extent); return span && centerOf(span) }
export function ageAt(time: number, birthDate?: string): number | undefined {
  const birth = calendarDate(birthDate)
  if (birth === undefined || time < birth) return undefined
  const current = new Date(time), born = new Date(birth)
  return current.getUTCFullYear() - born.getUTCFullYear()
    - (current.getUTCMonth() < born.getUTCMonth() || (current.getUTCMonth() === born.getUTCMonth() && current.getUTCDate() < born.getUTCDate()) ? 1 : 0)
}
export function filterTimeline(archive: Archive, filter: TimelineFilter): Entry[] {
  const extent = timelineExtent(archive.entries, archive.eras)
  const era = archive.eras.find(item => item.id === filter.eraId)
  const span = era && eraSpan(era, extent)
  return archive.entries.filter(entry => {
    if (!matchesFilters(entry, archive, { personId: filter.personId, placeId: filter.placeId, tagId: filter.tagId, entryType: filter.entryType })) return false
    const dates = eventSpan(entry.eventDate)
    if (filter.eraId && (!span || !dates || dates.end < span.start || dates.start > span.end)) return false
    if (filter.fromYear !== undefined && (!dates || dates.end < utc(filter.fromYear))) return false
    if (filter.toYear !== undefined && (!dates || dates.start >= utc(filter.toYear + 1))) return false
    return !filter.query?.trim() || keywordScore(entry, archive, filter.query) > 0
  })
}
export function positionMemories(entries: Entry[]): PositionedMemory[] {
  return entries.flatMap(entry => { const span = eventSpan(entry.eventDate); return span ? [{ entry, ...span }] : [] })
}
const intersects = (a: TimeSpan, b: TimeSpan) => a.end >= b.start && a.start <= b.end

export function deriveTimelineItems(memories: PositionedMemory[], view: TimeSpan, width: number, zoom: TimelineZoom, media: Archive['media'] = []): TimelineItem[] {
  const columns = Math.max(1, Math.floor(width / 230)), bucketWidth = width / columns
  const buckets = new Map<number, PositionedMemory[]>()
  const timeX = (time: number) => (time - view.start) / (view.end - view.start) * width
  for (const memory of memories) {
    if (!intersects(memory, view)) continue
    const x = Math.max(0, Math.min(width - 1, timeX(centerOf(memory))))
    const key = Math.floor(x / bucketWidth)
    const bucket = buckets.get(key) ?? []; bucket.push(memory); buckets.set(key, bucket)
  }
  const mediaById = new Map(media.map(item => [item.id, item]))
  const items: TimelineItem[] = []
  for (const [bucket, values] of [...buckets].sort(([a], [b]) => a - b)) {
    values.sort((a, b) => b.entry.importance - a.entry.importance || a.start - b.start || a.entry.id.localeCompare(b.entry.id))
    const wide = zoom === 'Entire Life' || zoom === 'Decades'
    // Bound both important and ordinary cards; even thousands of co-located milestones cannot flood the DOM.
    const individual = wide ? values.filter(item => item.entry.importance >= 4).slice(0, 1) : values.slice(0, 2)
    const chosen = new Set(individual.map(item => item.entry.id))
    const rest = values.filter(item => !chosen.has(item.entry.id))
    const groups = individual.map(item => [item])
    if (rest.length) groups.push(rest)
    groups.forEach((group, lane) => {
      const start = Math.min(...group.map(item => item.start)), end = Math.max(...group.map(item => item.end))
      const ids = new Set(group.flatMap(item => item.entry.mediaIds))
      items.push({ id: `${bucket}:${lane}:${group[0].entry.id}`, start, end, memories: group,
        kind: group.length === 1 ? 'memory' : 'cluster', lane,
        x: Math.max(bucket * bucketWidth + 4, Math.min((bucket + 1) * bucketWidth - 222, timeX(centerOf({ start, end })) - 109)),
        mediaCount: ids.size, photoCount: [...ids].filter(id => mediaById.get(id)?.mediaType === 'image').length })
    })
  }
  return items
}
export function clusterDestination(item: TimelineItem, zoom: TimelineZoom): TimelinePosition {
  return { focus: centerOf(item), zoom: stepZoom(zoom, 1) }
}
export function densityBins(memories: PositionedMemory[], extent: TimeSpan, count = 60) {
  const bins = Array.from({ length: count }, () => 0)
  for (const memory of memories) {
    const bin = Math.max(0, Math.min(count - 1, Math.floor((centerOf(memory) - extent.start) / (extent.end - extent.start) * count)))
    bins[bin]++
  }
  return bins
}
export function layoutEras(eras: LifeEra[], extent: TimeSpan, view: TimeSpan, width: number) {
  const rows: number[] = []
  return eras.flatMap(era => {
    const span = eraSpan(era, extent)
    return span && intersects(span, view) ? [{ era, ...span }] : []
  }).sort((a, b) => a.start - b.start || a.era.id.localeCompare(b.era.id)).map(item => {
    const x = Math.max(0, (item.start - view.start) / (view.end - view.start) * width)
    const labelX = Math.min(x, Math.max(0, width - 130))
    const endX = Math.min(width, (item.end - view.start) / (view.end - view.start) * width)
    let lane = rows.findIndex(end => end + 8 <= labelX)
    if (lane < 0) lane = rows.length
    rows[lane] = labelX + Math.max(130, endX - x)
    return { ...item, x, labelX, width: Math.max(1, endX - x), lane }
  })
}
export function canMoveAtZoom(zoom: TimelineZoom) { return zoom === 'Months' || zoom === 'Days' }

export function layoutDateSpans(items: TimelineItem[], view: TimeSpan, width: number) {
  const rows: number[] = []
  return [...items].sort((a, b) => a.start - b.start).map(item => {
    const left = Math.max(0, (item.start - view.start) / (view.end - view.start) * width)
    const right = Math.min(width, (item.end - view.start) / (view.end - view.start) * width)
    const labelLeft = Math.min(left, Math.max(0, width - 130))
    let lane = rows.findIndex(end => end + 8 <= labelLeft)
    if (lane < 0) lane = rows.length
    rows[lane] = Math.max(labelLeft + Math.min(200, width - labelLeft - 4), right)
    return { item, left, width: Math.max(8, right - left), labelLeft, lane }
  })
}

export function calendarTicks(view: TimeSpan, width: number, zoom: TimelineZoom): number[] {
  const target = Math.max(2, Math.floor(width / 160)), duration = view.end - view.start
  const ticks: number[] = [], date = new Date(view.start)
  if (zoom === 'Entire Life' || zoom === 'Decades') {
    const desired = duration / (365.25 * DAY) / target
    const step = [1, 2, 5, 10, 20, 50, 100, 500, 1000].find(value => value >= desired) ?? 1000
    let year = Math.ceil(date.getUTCFullYear() / step) * step
    for (; utc(year) <= view.end && ticks.length < 30; year += step) if (utc(year) >= view.start) ticks.push(utc(year))
  } else if (zoom === 'Years') {
    const step = duration / (30.44 * DAY) / target > 3 ? 6 : 3
    let month = Math.ceil(date.getUTCMonth() / step) * step
    for (; utc(date.getUTCFullYear(), month) <= view.end && ticks.length < 30; month += step) {
      const time = utc(date.getUTCFullYear(), month); if (time >= view.start) ticks.push(time)
    }
  } else {
    const step = Math.max(1, Math.ceil(duration / DAY / target))
    for (let time = Math.ceil(view.start / DAY) * DAY; time <= view.end && ticks.length < 30; time += step * DAY) ticks.push(time)
  }
  return ticks
}
