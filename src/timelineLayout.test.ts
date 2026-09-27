import { describe, expect, it } from 'vitest'
import { ageAt, calendarDate, calendarTicks, canMoveAtZoom, centerOf, changeZoom, clusterDestination, DAY, densityBins, deriveTimelineItems, eraSpan, eventSpan, filterTimeline, jumpToEra, jumpToYear, layoutDateSpans, layoutEras, positionMemories, stepZoom, timelineExtent, viewport, zoomDuration, ZOOM_LEVELS } from './timelineLayout'
import { createTimelineFixture } from './timelineFixture'
import { moveEventDate, restoreEventDate } from './dateMove'
import type { Archive, Entry, EventDate } from './types'
const stamp = (value: string) => calendarDate(value)!
function memory(id: string, date: Partial<EventDate> = {}, importance = 1): Entry {
  return { ...createTimelineFixture(1).entries[0], id, importance, peopleIds: [], mediaIds: [], eventDate: { precision: 'exact', start: '2014-06-15', confidence: 'confirmed', ...date } }
}
const extent = { start: stamp('1950-01-01'), end: stamp('2040-12-31') }
const view = { start: stamp('2014-01-01'), end: stamp('2014-12-31') }
const archive = (entries: Entry[]): Archive => ({ entries, people: [], places: [], tags: [], eras: [] })

describe('timeline calendar and precision', () => {
  it('rejects invalid calendar values rather than silently normalizing them', () => {
    expect(calendarDate('2023-02-29')).toBeUndefined(); expect(calendarDate('2024-02-29')).toBeDefined()
    expect(calendarDate('2020-13-01')).toBeUndefined(); expect(calendarDate('not-a-date')).toBeUndefined()
  })
  it('positions exact dates on their calendar day independent of timezone', () => {
    const span = eventSpan(memory('exact').eventDate)!
    expect(span.start).toBe(stamp('2014-06-15')); expect(span.end - span.start).toBe(DAY - 1); expect(span.uncertain).toBe(false)
  })
  it('uses full years/months instead of invented exact dates', () => {
    expect(eventSpan(memory('year', { precision: 'year', start: '2020-08-15' }).eventDate)).toEqual({ start: stamp('2020-01-01'), end: stamp('2021-01-01') - 1, uncertain: true })
    expect(eventSpan(memory('month', { precision: 'month', start: '2024-02-01' }).eventDate)!.end).toBe(stamp('2024-03-01') - 1)
  })
  it('marks approximate anchors without inventing an uncertainty interval', () => {
    const value = memory('about', { precision: 'approximate' })
    expect(eventSpan(value.eventDate)).toEqual({ start: stamp('2014-06-15'), end: stamp('2014-06-16') - 1, uncertain: true })
    expect(value.eventDate.precision).toBe('approximate')
  })
  it('spans ranges through the last day of a month-only end', () => {
    const span = eventSpan(memory('range', { precision: 'range', start: '2006-09', end: '2010-06' }).eventDate)!
    expect(span).toEqual({ start: stamp('2006-09-01'), end: stamp('2010-07-01') - 1, uncertain: true })
    expect(eventSpan(memory('bad', { precision: 'range', end: '2010-01' }).eventDate)).toBeUndefined()
  })
  it('uses labeled seasonal spans, including winter across years', () => {
    expect(eventSpan(memory('season', { precision: 'season', start: '2014-01', season: 'Summer' }).eventDate)!.start).toBe(stamp('2014-06-01'))
    expect(eventSpan(memory('winter', { precision: 'season', season: 'Winter' }).eventDate)!.end).toBe(stamp('2015-03-01') - 1)
    expect(eventSpan(memory('unspecified', { precision: 'season' }).eventDate)).toEqual({ start: stamp('2014-01-01'), end: stamp('2015-01-01') - 1, uncertain: true })
  })
  it('never positions age-only or unknown memories even if a legacy start exists', () => {
    expect(eventSpan(memory('age', { precision: 'age', age: 8 }).eventDate)).toBeUndefined()
    expect(eventSpan(memory('unknown', { precision: 'unknown' }).eventDate)).toBeUndefined()
  })
  it('calculates completed birthdays and hides ages before birth or without settings', () => {
    expect(ageAt(stamp('2006-06-14'), '1991-06-15')).toBe(14)
    expect(ageAt(stamp('2006-06-15'), '1991-06-15')).toBe(15)
    expect(ageAt(stamp('1990-01-01'), '1991-06-15')).toBeUndefined()
    expect(ageAt(stamp('2006-01-01'))).toBeUndefined()
    expect(ageAt(stamp('2024-02-29'), '2000-02-29')).toBe(24)
  })
})
describe('zoom, jumps, eras, and boundaries', () => {
  it('derives bounded calendar-aligned labels instead of repeated arbitrary year ticks', () => {
    const ticks = calendarTicks(view, 1000, 'Years')
    expect(ticks.length).toBeLessThanOrEqual(8)
    expect(ticks.every(time => new Date(time).getUTCDate() === 1)).toBe(true)
    expect(calendarTicks(extent, 390, 'Entire Life').length).toBeLessThanOrEqual(3)
  })
  it('offers decreasing useful durations and bounded zoom steps', () => {
    const durations = ZOOM_LEVELS.map(level => zoomDuration(level, extent))
    expect(durations).toEqual([...durations].sort((a, b) => b - a))
    expect(stepZoom('Days', 1)).toBe('Days'); expect(stepZoom('Entire Life', -1)).toBe('Entire Life')
  })
  it('keeps the focal date centered at every scale', () => {
    const position = { focus: stamp('2014-06-15'), zoom: 'Entire Life' as const }
    for (const level of ZOOM_LEVELS) { const next = changeZoom(position, level); expect(next.focus).toBe(position.focus); expect(centerOf(viewport(next, extent))).toBe(position.focus) }
  })
  it('jumps to year center, not January by accident', () => {
    expect(jumpToYear(2014)).toBe(centerOf({ start: stamp('2014-01-01'), end: stamp('2015-01-01') - 1 }))
    expect(jumpToYear(NaN)).toBeUndefined(); expect(jumpToYear(10000)).toBeUndefined()
  })
  it('spans/jumps eras and separates overlapping labels into lanes', () => {
    const eras = [{ id: 'a', name: 'School', start: '2006', end: '2010' }, { id: 'b', name: 'Family', start: '2008', end: '2012' }]
    const span = eraSpan(eras[0], extent)!
    expect(span.end).toBe(stamp('2011-01-01') - 1); expect(jumpToEra(eras[0], extent)).toBe(centerOf(span))
    expect(layoutEras(eras, extent, extent, 1000).map(item => item.lane)).toEqual([0, 1])
    expect(eraSpan({ id: 'open', name: 'Ongoing', start: '2000' }, extent)!.end).toBe(extent.end)
  })
  it('includes pre-birth and future dates without changing their records', () => {
    const entries = [memory('before', { start: '1900-01-01' }), memory('future', { start: '2050-01-01' })]
    const result = timelineExtent(entries, [], '1991-06-15', stamp('2026-09-26'))
    expect(result.start).toBeLessThan(stamp('1900-01-01')); expect(result.end).toBeGreaterThan(stamp('2050-01-01'))
    expect(deriveTimelineItems(positionMemories(entries), result, 1000, 'Entire Life').flatMap(item => item.memories).length).toBe(2)
  })
})
describe('canonical clustering and culling', () => {
  it('keeps spanning ranges and soft approximate markers on distinct date tracks', () => {
    const items = deriveTimelineItems(positionMemories([memory('range', { precision: 'range', start: '2000-01', end: '2020-01' }), memory('approximate', { precision: 'approximate' })]), view, 1000, 'Months')
    const tracks = layoutDateSpans(items, view, 1000)
    expect(tracks.length).toBe(2); expect(tracks[0].lane).not.toBe(tracks[1].lane)
    expect(tracks.find(track => track.item.memories[0].entry.id === 'range')!.width).toBe(1000)
  })
  it('clusters ordinary memories and retains a high-importance milestone individually', () => {
    const entries = [memory('a'), memory('b'), memory('milestone', {}, 5)]
    const snapshot = structuredClone(entries)
    const items = deriveTimelineItems(positionMemories(entries), view, 500, 'Entire Life')
    expect(items.find(item => item.kind === 'memory')!.memories[0].entry.id).toBe('milestone')
    expect(items.find(item => item.kind === 'cluster')!.memories.length).toBe(2)
    expect(entries).toEqual(snapshot)
  })
  it('counts unique referenced media/photos without reading binaries', () => {
    const first = memory('a'), second = memory('b'); first.mediaIds = ['photo', 'video']; second.mediaIds = ['photo', 'other']
    const media = [{ ...createTimelineFixture(2).media![0], id: 'photo', mediaType: 'image' as const }, { ...createTimelineFixture(2).media![0], id: 'video', mediaType: 'video' as const }]
    const cluster = deriveTimelineItems(positionMemories([first, second]), view, 500, 'Entire Life', media)[0]
    expect(cluster.mediaCount).toBe(3); expect(cluster.photoCount).toBe(1); expect(cluster.memories.length).toBe(2)
  })
  it('recomputes cluster counts from only filter-matching canonical entries', () => {
    const a = memory('dad'), b = memory('other'), c = memory('also-dad'); a.peopleIds = c.peopleIds = ['dad']
    const filtered = filterTimeline(archive([a, b, c]), { personId: 'dad' })
    const items = deriveTimelineItems(positionMemories(filtered), view, 500, 'Entire Life')
    expect(items[0].memories.map(item => item.entry.id)).toEqual(['also-dad', 'dad'])
    expect(items[0].memories.length).toBe(2)
  })
  it('uses uncertain spans for year/era overlap filters', () => {
    const entry = memory('year', { precision: 'year', start: '2014-01-01' })
    const data = { ...archive([entry]), eras: [{ id: 'summer', name: 'Summer', start: '2014-06', end: '2014-08' }] }
    expect(filterTimeline(data, { eraId: 'summer', fromYear: 2014, toYear: 2014 })).toEqual([entry])
    expect(filterTimeline(data, { fromYear: 2015 })).toEqual([])
  })
  it('culls offscreen memories but keeps ranges intersecting the window', () => {
    const entries = [memory('outside', { start: '1900-01-01' }), memory('range', { precision: 'range', start: '2000-01', end: '2020-01' })]
    expect(deriveTimelineItems(positionMemories(entries), view, 1000, 'Months').flatMap(item => item.memories).map(item => item.entry.id)).toEqual(['range'])
  })
  it('cluster activation centers its period and zooms in, including maximum zoom', () => {
    const cluster = deriveTimelineItems(positionMemories([memory('a'), memory('b')]), view, 500, 'Entire Life')[0]
    expect(clusterDestination(cluster, 'Entire Life')).toEqual({ focus: centerOf(cluster), zoom: 'Decades' })
    expect(clusterDestination(cluster, 'Days').zoom).toBe('Days')
  })
  it('detailed date movement retains precision, relationships, identity, and reversible dates', () => {
    expect(ZOOM_LEVELS.map(canMoveAtZoom)).toEqual([false, false, false, true, true])
    const before = memory('year', { precision: 'year', confidence: 'likely' })
    const moved = moveEventDate(before, { start: '2015-01-01' })
    expect(moved.eventDate.precision).toBe('year'); expect(moved.id).toBe(before.id)
    expect(moved.mediaIds).toEqual(before.mediaIds); expect(moved.recordTime).toBe(before.recordTime)
    expect(restoreEventDate(moved, before.eventDate)).toEqual(before)
  })
  it('derives a bounded layout for 2,000 memories / nearly 12,000 photos at every scale', () => {
    const data = createTimelineFixture(), snapshot = JSON.stringify(data)
    expect(data.entries.length).toBe(2000); expect(data.media!.length).toBeGreaterThan(11000)
    const positioned = positionMemories(data.entries), span = timelineExtent(data.entries, data.eras)
    for (const zoom of ZOOM_LEVELS) {
      const view = viewport({ focus: centerOf(span), zoom }, span)
      const items = deriveTimelineItems(positioned, view, 1200, zoom, data.media)
      expect(items.length).toBeLessThanOrEqual(15)
      expect(items.flatMap(item => item.memories).length).toBe(positioned.filter(item => item.end >= view.start && item.start <= view.end).length)
    }
    expect(densityBins(positioned, span).reduce((a, b) => a + b, 0)).toBe(positioned.length)
    expect(JSON.stringify(data)).toBe(snapshot)
  })
  it('bounds rendering even when thousands of important events share one day', () => {
    const data = Array.from({ length: 2000 }, (_, index) => memory(String(index), {}, 5))
    expect(deriveTimelineItems(positionMemories(data), view, 1000, 'Entire Life').length).toBe(2)
    expect(deriveTimelineItems(positionMemories(data), view, 1000, 'Days').length).toBe(3)
  })
})
