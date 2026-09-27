import { describe, expect, it } from 'vitest'
import { mockEmbeddingProvider } from './embeddingProvider'
import { buildSearchDocument, cosineSimilarity, keywordSearch, matchesFilters, rankSemanticResults, searchFingerprint, SEMANTIC_INDEX_VERSION, type SemanticVector } from './semanticSearch'
import { seed } from './seed'

const first = seed.entries[0]
const later = seed.entries[1]

describe('local semantic-search domain', () => {
  it('builds only the selected Memory text and named relationships, without unrelated stories, GPS, or media bytes', () => {
    const archive = { ...seed, places: seed.places.map(place => ({ ...place, latitude: 33.4, longitude: -112.1 })) }
    const document = buildSearchDocument(first, archive)
    expect(document.memoryId).toBe(first.id)
    expect(document.text).toContain(first.title)
    expect(document.text).toContain(first.body)
    expect(document.text).not.toContain(later.body)
    expect(document.text).not.toContain('33.4')
    expect(document.text).not.toContain('latitude')
  })

  it('uses stable fingerprints that change when indexed text or relationship names change', async () => {
    const original = await searchFingerprint(buildSearchDocument(first, seed))
    expect(await searchFingerprint(buildSearchDocument({ ...first, updatedAt: 'tomorrow' }, seed))).toBe(original)
    expect(await searchFingerprint(buildSearchDocument({ ...first, body: `${first.body} Changed` }, seed))).not.toBe(original)
    const renamed = { ...seed, people: seed.people.map(person => ({ ...person, name: `${person.name} renamed` })) }
    expect(await searchFingerprint(buildSearchDocument(first, renamed))).not.toBe(original)
  })

  it('uses deterministic mock embeddings and cosine similarity', async () => {
    const signal = new AbortController().signal
    const one = (await mockEmbeddingProvider.embedQuery('classroom', signal)).vectors[0]
    const two = (await mockEmbeddingProvider.embedQuery('classroom', signal)).vectors[0]
    const school = (await mockEmbeddingProvider.embedQuery('school', signal)).vectors[0]
    expect(one).toEqual(two)
    expect(cosineSimilarity(one, school)).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1], [1, 0])).toBe(0)
  })

  it('filters locally and boosts an exact title phrase in hybrid semantic ranking', () => {
    const vectors: SemanticVector[] = [
      { memoryId: first.id, sourceType: 'memory', model: 'test', dimension: 2, indexVersion: SEMANTIC_INDEX_VERSION, fingerprint: 'a', generatedAt: '', vector: [0.8, 0.6] },
      { memoryId: later.id, sourceType: 'memory', model: 'test', dimension: 2, indexVersion: SEMANTIC_INDEX_VERSION, fingerprint: 'b', generatedAt: '', vector: [1, 0] },
    ]
    const query = first.title
    expect(rankSemanticResults(seed, query, [1, 0], vectors)[0].entry.id).toBe(first.id)
    expect(rankSemanticResults(seed, query, [1, 0], vectors, { personId: 'missing' })).toEqual([])
    expect(matchesFilters(first, seed, { fromYear: 2004, toYear: 2004 })).toBe(true)
    expect(matchesFilters(first, seed, { fromYear: 2020 })).toBe(false)
    const ranged = { ...first, eventDate: { ...first.eventDate, precision: 'range' as const, start: '2000-01-01', end: '2010-12-31' } }
    expect(matchesFilters(ranged, seed, { fromYear: 2008, toYear: 2008 })).toBe(true)
    expect(matchesFilters(ranged, seed, { fromYear: 2011 })).toBe(false)
    expect(keywordSearch(seed, first.title)[0].entry.id).toBe(first.id)
    expect(keywordSearch(seed, 'not-in-any-memory')).toEqual([])
  })
})
