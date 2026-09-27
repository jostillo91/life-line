import { useEffect, useMemo, useRef, useState } from 'react'
import { dateLabel } from './date'
import type { EmbeddingInfo } from './embeddingProvider'
import { signInToRemoteAI } from './remoteAISession'
import type { IndexStatus } from './semanticIndex'
import { aiEndpoint as endpoint, embeddingProvider as provider, semanticService as service } from './searchRuntime'
import { keywordSearch, matchesFilters, type SearchFilters, type SearchResult } from './semanticSearch'
import { useMediaUrl } from './useMediaUrl'
import { AskLifeLine } from './AskLifeLine'
import type { Archive, Entry, Media } from './types'
import { useOnline } from './networkState'


export function SearchView({ data, onOpenMemory, onViewTimeline, askSeed }: { data: Archive; onOpenMemory: (entry: Entry) => void; onViewTimeline: (entry: Entry) => void; askSeed?: { question: string; nonce: number } }) {
  const online = useOnline()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'keyword' | 'semantic' | 'ask'>(askSeed ? 'ask' : 'keyword')
  const [filters, setFilters] = useState<SearchFilters>({})
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)
  const [info, setInfo] = useState<EmbeddingInfo>()
  const [indexStatus, setIndexStatus] = useState<IndexStatus>()
  const [providerState, setProviderState] = useState<'checking' | 'ready' | 'auth' | 'unavailable'>('checking')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => { if (askSeed) setMode('ask') }, [askSeed])

  async function refreshInfo() {
    if (!provider) { setProviderState('unavailable'); return }
    if (!online && provider.kind === 'remote') {setProviderState('unavailable');return}
    try { setInfo(await provider.info()); setProviderState('ready') }
    catch (cause) { setInfo(undefined); setProviderState(cause instanceof Error && cause.message.includes('Sign in') ? 'auth' : 'unavailable') }
  }

  useEffect(() => {
    let active = true
    service?.isEnabled().then(value => { if (active) setEnabled(value) })
    void refreshInfo()
    return () => { active = false; controller.current?.abort() }
  }, [online])

  useEffect(() => {
    if (!service || !info || !enabled) { setIndexStatus(undefined); return }
    let active = true
    service.plan(data, info).then(({ status }) => { if (active) setIndexStatus(status) }).catch(() => undefined)
    return () => { active = false }
  }, [data, info, enabled, busy])

  async function signIn() {
    setError('')
    try { await signInToRemoteAI(endpoint, password); await refreshInfo() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in.') }
    finally { setPassword('') }
  }

  async function enable() {
    if (!service || !consentChecked) return
    await service.setEnabled(true)
    setEnabled(true)
  }

  async function buildIndex(rebuild = false) {
    if (!service || !info || busy || (!online && provider?.kind === 'remote')) return
    const active = new AbortController()
    controller.current = active; setBusy(true); setError('')
    try {
      if (rebuild) await service.clearIndex()
      const result = await service.indexPending(data, info, active.signal, (done, total, failures) => setProgress(`${done} / ${total} processed${failures ? ` · ${failures} need retry` : ''}`))
      setProgress(`${result.indexed} indexed${result.failures ? ` · ${result.failures} need retry` : ''}`)
      setIndexStatus((await service.plan(data, info)).status)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Indexing failed.') }
    finally { controller.current = null; setBusy(false) }
  }

  async function clearIndex() {
    if (!service || busy || !window.confirm('Delete only the derived semantic search index? Your memories and media will remain.')) return
    await service.clearIndex()
    setResults([]); setSearched(false); setProgress('Semantic search index deleted.')
    if (info) setIndexStatus((await service.plan(data, info)).status)
  }

  async function search() {
    const clean = query.trim()
    if (!clean || busy) return
    setSearched(true); setError('')
    if (mode === 'keyword') { setResults(keywordSearch(data, clean)); return }
    if (!online && provider?.kind === 'remote') {setError('Semantic queries require connectivity for query embeddings. Your local index is preserved; keyword search works offline.');return}
    if (!enabled || !service || !info) { setError('Enable semantic search and sign in before searching.'); return }
    if (!indexStatus?.indexed) { setError('Index at least one memory before semantic searching.'); return }
    if (clean.length > 300) { setError('Shorten the semantic search to 300 characters.'); return }
    const active = new AbortController()
    controller.current = active; setBusy(true)
    try {
      setResults(await service.search(data, clean, info, active.signal))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Semantic search is unavailable.')
      setResults([])
    } finally { controller.current = null; setBusy(false) }
  }

  const visibleResults = useMemo(() => results.flatMap(result => {
    const entry = data.entries.find(item => item.id === result.entry.id)
    return entry && matchesFilters(entry, data, filters) ? [{ ...result, entry }] : []
  }), [results, data, filters])

  return <section className="search-view">
    <div className="timeline-heading"><div><span className="eyebrow">LOCAL-FIRST RETRIEVAL</span><h2>Search</h2></div></div>
    <p>Search results open your original memories. A match is a lead to review, not a new fact about your life.</p>
    <div className="search-modes"><label><input type="radio" name="search-mode" checked={mode === 'keyword'} onChange={() => { setMode('keyword'); setResults([]); setSearched(false) }}/> Keyword</label><label><input type="radio" name="search-mode" checked={mode === 'semantic'} onChange={() => { setMode('semantic'); setResults([]); setSearched(false) }}/> Semantic</label><label><input type="radio" name="search-mode" checked={mode === 'ask'} onChange={() => { setMode('ask'); setResults([]); setSearched(false) }}/> Ask Life Line</label></div>
    {mode !== 'ask' && <form className="search-query" onSubmit={event => { event.preventDefault(); void search() }}><input aria-label="Search your life" placeholder="Search your life..." value={query} onChange={event => setQuery(event.target.value)}/><button className="primary" disabled={!query.trim() || busy}>Search</button></form>}
    {mode === 'semantic' && <section className="search-index-controls">
      <h3>Semantic search</h3>
      {!online && <p role="status">Remote semantic queries require connectivity. Existing local vectors are preserved; use Keyword search offline.</p>}
      <p>Semantic search requires sending selected archive text to the configured AI provider to create numeric search representations called embeddings.</p>
      <p>Each Memory is sent separately with its title, story, date/Life Era context, People, Places, and Tags. No media files or raw GPS are sent. Search queries also go to the provider; comparison and ranking happen locally.</p>
      {!enabled ? <><label><input type="checkbox" checked={consentChecked} onChange={event => setConsentChecked(event.target.checked)}/> I choose to enable semantic indexing for this archive.</label><button disabled={!service || !consentChecked} onClick={() => void enable()}>Enable semantic search</button></>
        : <p role="status">{busy && progress ? `Indexing… ${progress}` : providerState === 'unavailable' ? 'Provider unavailable; keyword search still works.' : providerState === 'auth' ? 'Sign in to build or search the index.' : indexStatus ? `${indexStatus.indexed} memories indexed · ${indexStatus.pending} need updating${indexStatus.requiresRebuild ? ' · model changed: rebuild required' : ''}` : 'Checking index…'}</p>}
      {enabled && provider?.kind === 'remote' && providerState === 'auth' && <form onSubmit={event => { event.preventDefault(); void signIn() }}><label>Sign in to use semantic search <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label><button disabled={!password}>Sign in</button></form>}
      {enabled && providerState === 'ready' && <div className="search-index-actions"><button disabled={busy || !indexStatus?.pending} onClick={() => void buildIndex()}>Index memories needing updates</button><button disabled={busy} onClick={() => void buildIndex(true)}>Rebuild Semantic Index</button><button disabled={busy} onClick={() => void clearIndex()}>Delete Semantic Search Index</button></div>}
      {busy && <button type="button" onClick={() => controller.current?.abort()}>Cancel</button>}
      {progress && !busy && <p>{progress}</p>}
    </section>}
    <div className="search-filters">
      <label>From year <input type="number" value={filters.fromYear ?? ''} onChange={event => setFilters(value => ({ ...value, fromYear: event.target.value ? Number(event.target.value) : undefined }))}/></label>
      <label>To year <input type="number" value={filters.toYear ?? ''} onChange={event => setFilters(value => ({ ...value, toYear: event.target.value ? Number(event.target.value) : undefined }))}/></label>
      <SearchSelect label="Life Era" value={filters.eraId} options={data.eras} onChange={eraId => setFilters(value => ({ ...value, eraId }))}/>
      <SearchSelect label="Person" value={filters.personId} options={data.people} onChange={personId => setFilters(value => ({ ...value, personId }))}/>
      <SearchSelect label="Place" value={filters.placeId} options={data.places} onChange={placeId => setFilters(value => ({ ...value, placeId }))}/>
      <SearchSelect label="Tag" value={filters.tagId} options={data.tags} onChange={tagId => setFilters(value => ({ ...value, tagId }))}/>
      <label>Type <select value={filters.entryType ?? ''} onChange={event => setFilters(value => ({ ...value, entryType: event.target.value as SearchFilters['entryType'] }))}><option value="">Any</option>{(['memory', 'story', 'event', 'journal', 'milestone'] as const).map(type => <option key={type} value={type}>{type}</option>)}</select></label>
    </div>
    {mode === 'ask' && <AskLifeLine data={data} filters={filters} seedQuestion={askSeed?.question} onOpenMemory={onOpenMemory} onViewTimeline={onViewTimeline}/>}
    {mode !== 'ask' && <>
    {error && <p role="alert" className="assistant-error">{error}</p>}
    {searched && !busy && <p role="status">{visibleResults.length} {visibleResults.length === 1 ? 'memory' : 'memories'} found.</p>}
    <div className="search-results">{visibleResults.map(result => <SearchCard key={result.entry.id} entry={result.entry} data={data} onOpen={() => onOpenMemory(result.entry)}/>)}</div>
    </>}
  </section>
}

function SearchSelect({ label, value, options, onChange }: { label: string; value?: string; options: { id: string; name: string }[]; onChange: (value: string | undefined) => void }) {
  return <label>{label} <select value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}><option value="">Any</option>{options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
}

function SearchCard({ entry, data, onOpen }: { entry: Entry; data: Archive; onOpen: () => void }) {
  const firstImage = entry.mediaIds.map(id => data.media?.find(item => item.id === id)).find((item): item is Media => item?.mediaType === 'image')
  const preview = useMediaUrl(firstImage, 'thumbnail')
  const names = [
    ...entry.peopleIds.map(id => data.people.find(item => item.id === id)?.name),
    ...entry.placeIds.map(id => data.places.find(item => item.id === id)?.name),
    ...entry.tagIds.map(id => data.tags.find(item => item.id === id)?.name),
  ].filter(Boolean)
  return <article className="search-result"><button type="button" onClick={onOpen}>
    {preview.url && <img src={preview.url} alt="" loading="lazy"/>}
    <span><strong>{entry.title || 'Untitled memory'}</strong><small>{dateLabel(entry.eventDate)} · {entry.entryType}</small><span>{entry.body.slice(0, 220)}{entry.body.length > 220 ? '…' : ''}</span><small>{names.join(' · ')}</small></span>
  </button></article>
}
