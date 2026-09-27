import { dateLabel } from './date'
import { keywordScore, matchesFilters, matchingEras, type SearchFilters, type SearchResult } from './semanticSearch'
import type { Archive, Entry, EventDate } from './types'

export const ASK_MAX_EVIDENCE = 5
export type AskEvidence = { memoryId: string; title: string; body: string; date: string; eventDate: EventDate; people: string[]; places: string[]; tags: string[]; entryType: Entry['entryType'] }
export type AskClaim = { statement: string; sourceMemoryIds: string[] }
export type AskAnswer = { sufficiency: 'sufficient' | 'partial' | 'insufficient'; claims: AskClaim[]; sourceMemoryIds: string[]; unresolvedQuestions: string[] }
export type AskHints = { filters: SearchFilters; matchedNames: string[]; topic: string }

const stop = new Set('a an and are around at be before after did do for from have how i in is it me my of on or the then this to was were what when where which with about happened happening memories memory life line write wrote tell remember else'.split(' '))
const clean = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const names = (ids: string[], values: { id: string; name: string }[]) => ids.slice(0, 3).flatMap(id => { const name = values.find(value => value.id === id)?.name; return name ? [name.slice(0, 70)] : [] })

export function deriveAskHints(question: string, archive: Archive, explicit: SearchFilters = {}): AskHints {
  const q = clean(question)
  const named = <T extends { id: string; name: string }>(values: T[]) => [...values].sort((a, b) => b.name.length - a.name.length).find(value => q.includes(clean(value.name)))
  const person = named(archive.people)
  const placeAliases = archive.places.filter(value => value.name.includes(',') && q.includes(clean(value.name.split(',')[0])))
  const place = named(archive.places) ?? (placeAliases.length === 1 ? placeAliases[0] : undefined)
  const tag = named(archive.tags)
  const era = named(archive.eras)
  const year = question.match(/\b(?:18|19|20)\d{2}\b/)?.[0]
  const relation = q.match(/\b(before|after)\b/)?.[1]
  const movementAnchor = /\bmov(?:e|ed|ing)\b/.test(q)
    ? archive.entries.filter(entry => entry.deletedAt === undefined && /\bmov(?:e|ed|ing)\b/i.test(entry.title) && entry.eventDate.start) : []
  const anchorYear = movementAnchor.length === 1 ? Number(movementAnchor[0].eventDate.start!.slice(0, 4)) : undefined
  const filters: SearchFilters = { ...explicit,
    personId: explicit.personId ?? person?.id, placeId: explicit.placeId ?? place?.id,
    tagId: explicit.tagId ?? tag?.id, eraId: explicit.eraId ?? era?.id,
    fromYear: explicit.fromYear ?? (year ? Number(year) : relation === 'after' && anchorYear ? anchorYear + 1 : undefined),
    toYear: explicit.toYear ?? (year ? Number(year) : relation === 'before' && anchorYear ? anchorYear - 1 : undefined),
  }
  const excluded = new Set([person?.name, place?.name, tag?.name, era?.name].filter(Boolean).flatMap(name => clean(name!).split(' ')))
  const topic = q.split(' ').filter(word => word.length > 2 && !stop.has(word) && !excluded.has(word) && !/^\d{4}$/.test(word)).join(' ')
  return { filters, matchedNames: [person?.name, place?.name, tag?.name, era?.name].filter((name): name is string => Boolean(name)), topic }
}

export function selectAskEvidence(archive: Archive, question: string, hints: AskHints, semantic: SearchResult[] = []): AskEvidence[] {
  const semanticScore = new Map(semantic.map(result => [result.entry.id, result.score]))
  const tokens = hints.topic.split(' ').filter(Boolean)
  const candidates = archive.entries.filter(entry => matchesFilters(entry, archive, hints.filters)).flatMap(entry => {
    const keyword = tokens.length ? keywordScore(entry, archive, hints.topic) : 0
    const semanticValue = semanticScore.get(entry.id) ?? 0
    const structured = hints.matchedNames.length > 0 || hints.filters.fromYear !== undefined || hints.filters.eraId !== undefined || Boolean(hints.filters.personId || hints.filters.placeId || hints.filters.tagId)
    if (!structured && keyword <= 0 && semanticValue < 0.34) return []
    const title = clean(entry.title)
    const exact = title.includes(clean(question)) || (tokens.length > 0 && tokens.every(token => title.split(' ').includes(token))) ? 2 : 0
    return [{ entry, score: semanticValue + Math.min(keyword, 6) * 0.1 + exact + (structured ? 0.2 : 0) }]
  }).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, ASK_MAX_EVIDENCE)
  return candidates.map(({ entry }) => ({ memoryId: entry.id, title: entry.title.slice(0, 120), body: entry.body.slice(0, 650),
    date: dateLabel(entry.eventDate), eventDate: entry.eventDate, entryType: entry.entryType,
    people: names(entry.peopleIds, archive.people), places: names(entry.placeIds, archive.places), tags: names(entry.tagIds, archive.tags) }))
}

export function localEvidence(archive: Archive, evidence: AskEvidence[]) {
  return evidence.flatMap(item => {
    const entry = archive.entries.find(value => value.id === item.memoryId)
    return entry && entry.deletedAt === undefined ? [{ entry, date: dateLabel(entry.eventDate), excerpt: entry.body.slice(0, 180), eras: matchingEras(entry, archive).map(era => era.name) }] : []
  })
}

export function isEvidenceCurrent(archive: Archive, evidence: AskEvidence): boolean {
  const entry = archive.entries.find(value => value.id === evidence.memoryId)
  return Boolean(entry && entry.deletedAt === undefined && entry.title.slice(0, 120) === evidence.title && entry.body.slice(0, 650) === evidence.body
    && dateLabel(entry.eventDate) === evidence.date && JSON.stringify(entry.eventDate) === JSON.stringify(evidence.eventDate)
    && JSON.stringify(names(entry.peopleIds, archive.people)) === JSON.stringify(evidence.people)
    && JSON.stringify(names(entry.placeIds, archive.places)) === JSON.stringify(evidence.places)
    && JSON.stringify(names(entry.tagIds, archive.tags)) === JSON.stringify(evidence.tags))
}

export function dateDescriptionConflicts(evidence: AskEvidence[]): Array<[AskEvidence, AskEvidence]> {
  const conflicts: Array<[AskEvidence, AskEvidence]> = []
  for (let i = 0; i < evidence.length; i++) for (let j = i + 1; j < evidence.length; j++) {
    if (clean(evidence[i].title) === clean(evidence[j].title) && evidence[i].date !== evidence[j].date) conflicts.push([evidence[i], evidence[j]])
  }
  return conflicts
}

export function validAskAnswer(raw: unknown, evidence: AskEvidence[]): raw is AskAnswer {
  if (!raw || typeof raw !== 'object') return false
  const answer = raw as Record<string, unknown>
  if (Object.keys(answer).some(key => !['sufficiency', 'claims', 'sourceMemoryIds', 'unresolvedQuestions'].includes(key))) return false
  const ids = new Set(evidence.map(item => item.memoryId))
  const validIds = (value: unknown) => Array.isArray(value) && value.length <= ASK_MAX_EVIDENCE && value.every(id => typeof id === 'string' && ids.has(id))
  if (!['sufficient', 'partial', 'insufficient'].includes(String(answer.sufficiency)) || !Array.isArray(answer.claims) || answer.claims.length > 6 || !validIds(answer.sourceMemoryIds)
    || !Array.isArray(answer.unresolvedQuestions) || answer.unresolvedQuestions.length > 3 || answer.unresolvedQuestions.some(value => typeof value !== 'string' || value.length > 220)) return false
  if (answer.claims.some(value => !value || typeof value !== 'object' || Object.keys(value).some(key => !['statement', 'sourceMemoryIds'].includes(key)) || typeof value.statement !== 'string' || !value.statement.trim() || value.statement.length > 500 || !validIds(value.sourceMemoryIds) || value.sourceMemoryIds.length < 1)) return false
  const cited = new Set((answer.claims as AskClaim[]).flatMap(claim => claim.sourceMemoryIds))
  return (answer.sourceMemoryIds as string[]).every(id => cited.has(id)) && [...cited].every(id => (answer.sourceMemoryIds as string[]).includes(id))
    && (answer.sufficiency === 'insufficient' ? answer.claims.length === 0 : answer.claims.length > 0)
}
