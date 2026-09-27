import { describe, expect, it } from 'vitest'
import { dateDescriptionConflicts, deriveAskHints, isEvidenceCurrent, localEvidence, selectAskEvidence, validAskAnswer } from './askDomain'
import { mockAskAnswer } from './askProvider'
import { seed } from './seed'

describe('Ask Life Line evidence', () => {
  it('resolves exact Person, Place, Tag, and year hints before ranking', () => {
    const person = deriveAskHints('What do I remember about Grandma Rosa?', seed)
    expect(person.filters.personId).toBe('p-grandma')
    expect(selectAskEvidence(seed, 'Grandma Rosa', person).map(item => item.memoryId)).toEqual(['m-pokemon'])
    const place = deriveAskHints("What happened at Grandma's house?", seed)
    expect(place.filters.placeId).toBe('pl-grandma')
    expect(selectAskEvidence(seed, "Grandma's house", place).map(item => item.memoryId)).toEqual(['m-pokemon'])
    expect(deriveAskHints('What happened in Phoenix?', seed).filters.placeId).toBe('pl-phoenix')
    const dated = deriveAskHints('What happened around 2010?', seed)
    expect(dated.filters).toMatchObject({ fromYear: 2010, toYear: 2010 })
    expect(selectAskEvidence(seed, '2010', dated).map(item => item.memoryId)).toEqual(['m-move'])
    expect(deriveAskHints('What was tagged school?', seed).filters.tagId).toBe('t-school')
    expect(deriveAskHints('What happened before I moved?', seed).filters.toYear).toBe(2009)
  })

  it('uses bounded canonical evidence, excludes private media/GPS, and boosts an exact title', () => {
    const data = { ...seed, places: seed.places.map(place => ({ ...place, latitude: 33.5, longitude: -112.1 })) }
    const hints = deriveAskHints('Moving to Phoenix', data)
    const evidence = selectAskEvidence(data, 'Moving to Phoenix', hints, seed.entries.map(entry => ({ entry, score: entry.id === 'm-pokemon' ? 0.9 : 0.2 })))
    expect(evidence[0].memoryId).toBe('m-move')
    expect(evidence.length).toBeLessThanOrEqual(5)
    expect(JSON.stringify(evidence)).not.toContain('latitude')
    expect(JSON.stringify(evidence)).not.toContain('33.5')
    expect(JSON.stringify(evidence)).not.toContain('mediaIds')
    expect(localEvidence(data, evidence)[0].entry.id).toBe('m-move')
    expect(isEvidenceCurrent(data, evidence[0])).toBe(true)
    expect(isEvidenceCurrent({ ...data, entries: data.entries.map(entry => entry.id === evidence[0].memoryId ? { ...entry, body: 'Changed since answering' } : entry) }, evidence[0])).toBe(false)
  })

  it('preserves approximate/age dates and rejects fabricated citations', () => {
    const evidence = selectAskEvidence(seed, 'Grandma Rosa', deriveAskHints('Grandma Rosa', seed))
    expect(evidence[0].eventDate).toMatchObject({ precision: 'age', confidence: 'guess', age: 8 })
    const answer = mockAskAnswer({ question: 'Grandma?', evidence })
    expect(validAskAnswer(answer, evidence)).toBe(true)
    expect(answer.claims[0].statement).toContain('age, guess')
    expect(validAskAnswer({ ...answer, claims: [{ statement: 'Invented', sourceMemoryIds: ['fabricated'] }] }, evidence)).toBe(false)
    expect(validAskAnswer({ ...answer, sufficiency: 'insufficient' }, evidence)).toBe(false)
  })

  it('requires evidence for weak questions and supports date-range overlap', () => {
    expect(selectAskEvidence(seed, 'quantum submarine', deriveAskHints('quantum submarine', seed))).toEqual([])
    const ranged = { ...seed.entries[0], eventDate: { ...seed.entries[0].eventDate, precision: 'range' as const, start: '2000-01-01', end: '2010-12-31' } }
    const data = { ...seed, entries: [ranged] }
    expect(selectAskEvidence(data, 'What happened in 2008?', deriveAskHints('What happened in 2008?', data))).toHaveLength(1)
  })

  it('keeps conflicting and approximate source dates separate in grounded mock claims', () => {
    const first = seed.entries.find(entry => entry.id === 'm-move')!
    const conflict = { ...first, id: 'm-conflict', title: 'Another account of the move', eventDate: { precision: 'approximate' as const, start: '2012-01-01', confidence: 'guess' as const } }
    const data = { ...seed, entries: [first, conflict] }
    const evidence = selectAskEvidence(data, 'Phoenix', deriveAskHints('Phoenix', data))
    const answer = mockAskAnswer({ question: 'When did I move?', evidence })
    expect(answer.claims).toHaveLength(2)
    expect(answer.claims.map(claim => claim.sourceMemoryIds[0]).sort()).toEqual(['m-conflict', 'm-move'])
    expect(answer.claims.some(claim => claim.statement.includes('approximate, guess'))).toBe(true)
    expect(answer.claims.some(claim => claim.statement.includes('year, confirmed'))).toBe(true)
    expect(dateDescriptionConflicts(evidence)).toEqual([])
    expect(dateDescriptionConflicts([{ ...evidence[0], title: 'Same event' }, { ...evidence[1], title: 'Same event' }])).toHaveLength(1)
  })
})
