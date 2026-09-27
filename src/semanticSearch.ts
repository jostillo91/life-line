import { dateLabel } from './date'
import type { Archive, Entry } from './types'

export const SEMANTIC_INDEX_VERSION = 1
export interface SearchDocument { memoryId: string; text: string }
export interface SemanticVector { memoryId: string; sourceType: 'memory'; model: string; dimension: number; indexVersion: number; fingerprint: string; generatedAt: string; vector: number[] }
export interface SemanticSetting { key: 'enabled'; enabled: boolean }
export interface SearchFilters { fromYear?: number; toYear?: number; eraId?: string; personId?: string; placeId?: string; tagId?: string; entryType?: Entry['entryType'] | '' }
export interface SearchResult { entry: Entry; score: number }

const compact = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit)
const named = (ids: string[], values: { id: string; name: string }[]) => ids.map(id => values.find(value => value.id === id)?.name).filter((name): name is string => Boolean(name)).sort((a, b) => a.localeCompare(b))

export function matchingEras(entry: Entry, archive: Archive) {
  const start = entry.eventDate.start
  if (!start) return []
  const end = entry.eventDate.end || start
  return archive.eras.filter(era => (!era.start || era.start <= end) && (!era.end || era.end >= start))
}

export function buildSearchDocument(entry: Entry, archive: Archive): SearchDocument {
  const lines = [
    `Title: ${compact(entry.title, 120)}`,
    `Story: ${compact(entry.body, 2800)}`,
    `Date: ${compact(dateLabel(entry.eventDate), 120)}`,
    `Life era: ${named(matchingEras(entry, archive).map(era => era.id), archive.eras).join(', ')}`,
    `People: ${named(entry.peopleIds, archive.people).join(', ')}`,
    `Places: ${named(entry.placeIds, archive.places).join(', ')}`,
    `Tags: ${named(entry.tagIds, archive.tags).join(', ')}`,
  ]
  return { memoryId: entry.id, text: lines.join('\n').slice(0, 3500) }
}

export async function searchFingerprint(document: SearchDocument): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.text))
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0
  let dot = 0; let leftSize = 0; let rightSize = 0
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) return 0
    dot += left[i] * right[i]; leftSize += left[i] ** 2; rightSize += right[i] ** 2
  }
  return leftSize && rightSize ? dot / Math.sqrt(leftSize * rightSize) : 0
}

export function matchesFilters(entry: Entry, archive: Archive, filters: SearchFilters): boolean {
  if(entry.deletedAt !== undefined) return false
  const startYear = entry.eventDate.start ? Number(entry.eventDate.start.slice(0, 4)) : undefined
  const endYear = entry.eventDate.end ? Number(entry.eventDate.end.slice(0, 4)) : startYear
  if (filters.fromYear !== undefined && (endYear === undefined || endYear < filters.fromYear)) return false
  if (filters.toYear !== undefined && (startYear === undefined || startYear > filters.toYear)) return false
  if (filters.eraId && !matchingEras(entry, archive).some(era => era.id === filters.eraId)) return false
  if (filters.personId && !entry.peopleIds.includes(filters.personId)) return false
  if (filters.placeId && !entry.placeIds.includes(filters.placeId)) return false
  if (filters.tagId && !entry.tagIds.includes(filters.tagId)) return false
  if (filters.entryType && entry.entryType !== filters.entryType) return false
  return true
}

export function keywordScore(entry: Entry, archive: Archive, query: string): number {
  const phrase = query.toLocaleLowerCase().trim()
  if (!phrase) return 0
  const title = entry.title.toLocaleLowerCase()
  const body = entry.body.toLocaleLowerCase()
  const context = buildSearchDocument(entry, archive).text.toLocaleLowerCase()
  const words = phrase.split(/\s+/).filter(Boolean)
  return (title.includes(phrase) ? 4 : 0) + (body.includes(phrase) ? 2 : 0)
    + words.filter(word => context.includes(word)).length / words.length
}

export function keywordSearch(archive: Archive, query: string, filters: SearchFilters = {}): SearchResult[] {
  if (!query.trim()) return []
  return archive.entries.filter(entry => matchesFilters(entry, archive, filters)).map(entry => ({ entry, score: keywordScore(entry, archive, query) }))
    .filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
}

export function rankSemanticResults(archive: Archive, query: string, queryVector: number[], vectors: SemanticVector[], filters: SearchFilters = {}): SearchResult[] {
  const byId = new Map(vectors.map(vector => [vector.memoryId, vector]))
  return archive.entries.filter(entry => matchesFilters(entry, archive, filters)).flatMap(entry => {
    const vector = byId.get(entry.id)
    if (!vector || vector.dimension !== queryVector.length) return []
    const similarity = cosineSimilarity(queryVector, vector.vector)
    const exactBoost = entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? 0.3 : 0
    const keywordBoost = Math.min(keywordScore(entry, archive, query), 4) * 0.025
    return [{ entry, score: similarity + exactBoost + keywordBoost }]
  }).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
}
