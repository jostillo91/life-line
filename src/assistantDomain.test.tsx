import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MemoryAssistant } from './MemoryAssistant'
import { applySuggestion, applyTagSuggestion, applyWritingDraft, buildAIContext, defaultContextSelection, estimateContextCharacters, MemoryAssistantService, type AIProvider, type AISuggestion } from './assistantDomain'
import { mockAIProvider } from './mockAIProvider'
import type { Archive, Entry } from './types'

const entry: Entry = {
  id: 'selected', title: 'Camping with Rosa in Phoenix', body: 'Rosa came camping in Phoenix with my family.',
  entryType: 'memory', eventDate: { precision: 'year', start: '2004-01-01', confidence: 'likely' },
  recordTime: '2026-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01', importance: 2,
  status: 'active', peopleIds: [], placeIds: [], tagIds: [], mediaIds: ['photo'], relatedEntryIds: ['related'],
}
const related: Entry = { ...entry, id: 'related', title: 'Another trip', body: 'A related recollection.', eventDate: { precision: 'year', start: '2006-01-01', confidence: 'guess' }, mediaIds: [], relatedEntryIds: [] }
const unrelated: Entry = { ...entry, id: 'unrelated', title: 'Private unrelated story', body: 'Secret detail that must not leak.', relatedEntryIds: [] }
const archive: Archive = {
  entries: [entry, related, unrelated],
  people: [{ id: 'rosa', name: 'Rosa' }, { id: 'other', name: 'Unrelated Person' }],
  places: [{ id: 'phoenix', name: 'Phoenix', latitude: 33.45, longitude: -112.07 }, { id: 'other', name: 'Unrelated Place', latitude: 1, longitude: 2 }],
  tags: [{ id: 'family', name: 'Family', color: '#fff' }], eras: [{ id: 'childhood', name: 'Childhood', start: '1990-01-01', end: '2009-12-31' }],
  media: [{ id: 'photo', mediaType: 'image', filename: 'family.jpg', mimeType: 'image/jpeg', byteSize: 12, importedAt: '2026-01-01', storageKey: 'binary/photo', version: 1, photoMetadata: { latitude: 55, longitude: 66 } }],
}
const suggestion = (type: AISuggestion['type'], content: AISuggestion['content']): AISuggestion => ({
  id: 's1', type, content, sourceMemoryId: entry.id, provider: 'mock', createdAt: '2026-01-01', status: 'pending',
  contextReferences: { relatedMemoryIds: [], categories: ['this memory'] },
})

describe('Memory Assistant privacy boundary', () => {
  it('includes only selected context, excluding unrelated stories and names', () => {
    const context = buildAIContext('remember', entry, archive, defaultContextSelection())
    expect(context.memory.id).toBe('selected')
    expect(JSON.stringify(context)).not.toContain('Secret detail')
    expect(JSON.stringify(context)).not.toContain('Unrelated Person')
    expect(context.relatedMemories).toEqual([])
    const selected = buildAIContext('remember', entry, archive, { ...defaultContextSelection(), relatedIds: ['related'] })
    expect(selected.relatedMemories.map(item => item.id)).toEqual(['related'])
  })

  it('excludes GPS and binary/media by default; exact coordinates require an explicit selection', () => {
    const context = buildAIContext('remember', entry, archive, defaultContextSelection())
    expect(JSON.stringify(context)).not.toContain('33.45')
    expect(JSON.stringify(context)).not.toContain('55')
    expect(context.media).toEqual([])
    const chosen = buildAIContext('remember', { ...entry, placeIds: ['phoenix'] }, archive, { ...defaultContextSelection(), includeMedia: true, includeExactCoordinates: true })
    expect(chosen.places[0].coordinates).toEqual({ latitude: 33.45, longitude: -112.07 })
    expect(chosen.media[0]).toMatchObject({ filename: 'family.jpg' })
    expect(JSON.stringify(chosen)).not.toContain('storageKey')
    expect(JSON.stringify(chosen)).not.toContain('photoMetadata')
    expect(buildAIContext('organize', entry, archive, { ...defaultContextSelection(), includeMedia: true }).media).toEqual([])
  })

  it('limits oversized text and related context deterministically', () => {
    const huge = { ...entry, body: 'a'.repeat(30000) }
    const context = buildAIContext('remember', huge, archive, { ...defaultContextSelection(), relatedIds: ['related', 'unrelated'] })
    expect(context.truncated).toBe(true)
    expect(context.memory.body.length).toBeLessThanOrEqual(3201)
    expect(estimateContextCharacters(context)).toBeLessThanOrEqual(6500)
  })

  it('requires remote consent before invoking a remote provider', async () => {
    const generate = vi.fn(async () => [])
    const provider: AIProvider = { id: 'remote-test', kind: 'remote', generate }
    const service = new MemoryAssistantService(provider)
    await expect(service.request('remember', entry, archive, defaultContextSelection())).rejects.toThrow('consent')
    expect(generate).not.toHaveBeenCalled()
    await service.request('remember', entry, archive, defaultContextSelection(), { remoteConsent: true })
    expect(generate).toHaveBeenCalledOnce()
  })

  it('honors cancellation even if a provider never resolves, and limits questions to one', async () => {
    const abort = new AbortController()
    const stalled = new MemoryAssistantService({ id: 'stalled', kind: 'local', generate: async () => new Promise(() => {}) })
    const pending = stalled.request('remember', entry, archive, defaultContextSelection(), { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toThrow('cancelled')
    const many = new MemoryAssistantService({ id: 'many', kind: 'local', generate: async () => [
      { type: 'question', content: { text: 'One?' } }, { type: 'question', content: { text: 'Two?' } },
    ] })
    expect((await many.request('remember', entry, archive, defaultContextSelection())).suggestions).toHaveLength(1)
  })

  it('leaves archive data untouched on failure or when no provider is configured', async () => {
    const before = JSON.stringify(archive)
    await expect(new MemoryAssistantService().request('remember', entry, archive, defaultContextSelection())).rejects.toThrow('not configured')
    await expect(new MemoryAssistantService({ id: 'failure', kind: 'local', generate: async () => { throw Error('offline') } }).request('remember', entry, archive, defaultContextSelection())).rejects.toThrow('offline')
    expect(JSON.stringify(archive)).toBe(before)
    const html = renderToStaticMarkup(<MemoryAssistant entry={entry} data={archive} onApply={() => {}} onAddTag={async () => undefined} service={new MemoryAssistantService()}/>)
    expect(html).toContain('Memory Assistant')
  })
})

describe('suggestion acceptance boundary', () => {
  it('keeps mock output separate and records provenance', async () => {
    const before = JSON.stringify(entry)
    const { suggestions } = await new MemoryAssistantService(mockAIProvider).request('organize', entry, archive, defaultContextSelection())
    expect(suggestions[0]).toMatchObject({ status: 'pending', sourceMemoryId: entry.id, provider: 'local-mock' })
    expect(suggestions[0].contextReferences.categories).toContain('this memory')
    expect(JSON.stringify(entry)).toBe(before)
  })

  it('reuses normalized tags and does not create a duplicate', async () => {
    const create = vi.fn(async () => 'new-tag')
    const next = await applyTagSuggestion(entry, suggestion('tag', { text: '  family  ' }), archive, create)
    expect(next?.tagIds).toEqual(['family'])
    expect(create).not.toHaveBeenCalled()
  })

  it('rejecting a suggestion changes no archive data', () => {
    const rejected = { ...suggestion('importance', { text: 'Important', value: 5 }), status: 'rejected' as const }
    expect(applySuggestion(entry, rejected, archive)).toBeNull()
    expect(entry.importance).toBe(2)
  })

  it('does not replace original prose without explicit insert or replace', () => {
    const draft = suggestion('draft', { text: 'Proposed prose.' })
    expect(entry.body).toContain('Rosa came camping')
    expect(applySuggestion(entry, draft, archive)).toBeNull()
    expect(applyWritingDraft(entry, draft, 'insert')?.body).toContain(`${entry.body}\n\nProposed prose.`)
    expect(applyWritingDraft(entry, draft, 'replace')?.body).toBe('Proposed prose.')
    expect(entry.body).toContain('Rosa came camping')
  })

  it('never directly applies proposed dates', () => {
    const date = suggestion('date', { text: 'Maybe 2006', proposedDate: { precision: 'year', start: '2006-01-01', confidence: 'guess' }, reason: 'Another recollection' })
    expect(applySuggestion(entry, date, archive)).toBeNull()
    expect(entry.eventDate.start).toBe('2004-01-01')
  })

  it('matches existing People and Places only; unknown names are not created', () => {
    const context = buildAIContext('connections', entry, archive, defaultContextSelection())
    expect(context.people).toMatchObject([{ id: 'rosa', name: 'Rosa', linked: false }])
    expect(context.places).toMatchObject([{ id: 'phoenix', name: 'Phoenix', linked: false }])
    expect(context.eras).toMatchObject([{ id: 'childhood', name: 'Childhood' }])
    expect(applySuggestion(entry, suggestion('person', { text: 'Rosa', targetId: 'rosa' }), archive)?.peopleIds).toEqual(['rosa'])
    expect(applySuggestion(entry, suggestion('place', { text: 'Phoenix', targetId: 'phoenix' }), archive)?.placeIds).toEqual(['phoenix'])
    expect(applySuggestion(entry, suggestion('person', { text: 'Unknown' }), archive)).toBeNull()
    expect(applySuggestion(entry, suggestion('place', { text: 'Unknown', targetId: 'missing' }), archive)).toBeNull()
  })

  it('keeps disposable pending/rejected suggestions outside archive records', () => {
    const before = JSON.stringify(archive)
    const pending = suggestion('tag', { text: 'Travel' })
    expect(JSON.stringify(archive)).toBe(before)
    expect(archive.entries[0]).not.toHaveProperty('suggestions')
    expect(pending.status).toBe('pending')
  })
})
