import { useEffect, useMemo, useRef, useState } from 'react'
import { applySuggestion, applyTagSuggestion, applyWritingDraft, buildAIContext, defaultContextSelection, estimateContextCharacters, MemoryAssistantService, type AISuggestion, type AssistantTask, type ContextSelection } from './assistantDomain'
import { failNextMockRequest, mockAIProvider } from './mockAIProvider'
import { createRemoteAIProvider, RemoteAIError } from './remoteAIProvider'
import { getRemoteAIStatus, signInToRemoteAI, signOutOfRemoteAI, type RemoteAIStatus } from './remoteAISession'
import type { Archive, Entry } from './types'
import { useOnline } from './networkState'

const consentKey = 'life-line:remote-ai-consent'
const remoteEndpoint = import.meta.env.VITE_LIFE_LINE_AI_ENDPOINT || '/api/memory-assistant'
const configuredProvider = import.meta.env.VITE_LIFE_LINE_AI_MODE === 'openai'
  ? createRemoteAIProvider(remoteEndpoint)
  : import.meta.env.VITE_LIFE_LINE_AI_MODE === 'mock' || (import.meta.env.DEV && !import.meta.env.VITE_LIFE_LINE_AI_MODE)
    ? mockAIProvider : undefined
const defaultService = new MemoryAssistantService(configuredProvider)
const hasRememberedConsent = () => { try { return localStorage.getItem(consentKey) === 'yes' } catch { return false } }
const saveRememberedConsent = () => { try { localStorage.setItem(consentKey, 'yes') } catch { /* session consent still works */ } }

interface Props {
  entry: Entry
  data: Archive
  onApply: (entry: Entry) => Promise<void> | void
  onAddTag: (name: string) => Promise<string | undefined>
  onReviewDate?: () => void
  service?: MemoryAssistantService
}

export function MemoryAssistant({ entry, data, onApply, onAddTag, onReviewDate, service = defaultService }: Props) {
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<ContextSelection>(defaultContextSelection)
  const [task, setTask] = useState<AssistantTask>('remember')
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [awaitingConsent, setAwaitingConsent] = useState(false)
  const [rememberConsent, setRememberConsent] = useState(false)
  const [sessionConsent, setSessionConsent] = useState(false)
  const [answer, setAnswer] = useState('')
  const [questionIndex, setQuestionIndex] = useState(0)
  const [remoteStatus, setRemoteStatus] = useState<RemoteAIStatus | 'checking'>('checking')
  const [accessPassword, setAccessPassword] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const currentEntry = useRef(entry)
  currentEntry.current = entry
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (!open || service.provider?.kind !== 'remote') return
    if (!online) {controller.current?.abort();setRemoteStatus('unavailable');return}
    let active = true
    setRemoteStatus('checking')
    getRemoteAIStatus(remoteEndpoint).then(status => { if (active) setRemoteStatus(status) })
    return () => { active = false }
  }, [open, service.provider, online])

  const relatedChoices = entry.relatedEntryIds.flatMap(id => {
    const related = data.entries.find(item => item.id === id && item.id !== entry.id)
    return related ? [related] : []
  })
  const context = useMemo(() => buildAIContext(task, entry, data, selection, answer || undefined), [task, entry, data, selection, answer])
  const setStatus = (id: string, status: AISuggestion['status']) => setSuggestions(values => values.map(item => item.id === id ? { ...item, status } : item))
  const canAccept = (item: AISuggestion) => item.type === 'person' ? data.people.some(value => value.id === item.content.targetId)
    : item.type === 'place' ? data.places.some(value => value.id === item.content.targetId)
      : item.type === 'related' ? data.entries.some(value => value.id === item.content.targetId && value.id !== entry.id)
        : item.type !== 'era' && item.type !== 'caution'

  async function request(nextTask: AssistantTask, consent = false) {
    if (!service.provider || loading || controller.current) return
    if (service.provider.kind === 'remote' && (!online || (remoteStatus !== 'ready' && remoteStatus !== 'mock'))) return
    setTask(nextTask)
    if (service.provider.kind === 'remote' && !consent && !sessionConsent && !hasRememberedConsent()) {
      setAwaitingConsent(true)
      return
    }
    setAwaitingConsent(false)
    setError('')
    setLoading(true)
    const active = new AbortController()
    controller.current = active
    try {
      const result = await service.request(nextTask, currentEntry.current, data, selection, {
        signal: active.signal, remoteConsent: service.provider.kind === 'local' || consent || sessionConsent || hasRememberedConsent(),
        questionIndex, draftAnswer: nextTask === 'remember' ? answer : undefined,
      })
      setSuggestions(values => [...values.map(item => nextTask === 'remember' && item.type === 'question' && item.status === 'pending' ? { ...item, status: 'rejected' as const } : item), ...result.suggestions])
      if (nextTask === 'remember') setQuestionIndex(value => value + 1)
    } catch (cause) {
      if (cause instanceof RemoteAIError && cause.code === 'authentication_required') setRemoteStatus('authentication_required')
      setError(cause instanceof Error ? cause.message : 'Assistant request failed. Your memory was not changed.')
    } finally {
      controller.current = null
      setLoading(false)
      setSelection(value => value.includeExactCoordinates ? { ...value, includeExactCoordinates: false } : value)
    }
  }

  async function signIn() {
    setSigningIn(true)
    setError('')
    try { setRemoteStatus(await signInToRemoteAI(remoteEndpoint, accessPassword)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in.') }
    finally { setAccessPassword(''); setSigningIn(false) }
  }

  async function accept(item: AISuggestion, mode?: 'insert' | 'replace') {
    try {
      const before = currentEntry.current
      let next: Entry | null = null
      if (item.type === 'tag') next = await applyTagSuggestion(before, item, data, onAddTag)
      else if (item.type === 'draft' && mode) next = applyWritingDraft(before, item, mode)
      else next = applySuggestion(before, item, data)
      if (!next) return
      await onApply(next)
      currentEntry.current = next
      setStatus(item.id, 'accepted')
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply suggestion. Your memory was not changed.')
    }
  }

  async function addAnswer() {
    if (!answer.trim()) return
    const next = { ...currentEntry.current, body: [currentEntry.current.body.trim(), answer.trim()].filter(Boolean).join('\n\n') }
    try {
      await onApply(next)
      currentEntry.current = next
      setAnswer('')
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add answer. Your memory was not changed.')
    }
  }

  return <div className="memory-assistant-entry">
    <button type="button" className="quiet" onClick={() => setOpen(value => !value)} aria-expanded={open}>Memory Assistant</button>
    {open && <section className="memory-assistant" aria-label="Memory Assistant">
      <div className="assistant-heading"><div><span className="eyebrow">OPTIONAL · SUGGESTIONS ONLY</span><h3>Memory Assistant</h3></div><button type="button" className="close" onClick={() => { controller.current?.abort(); setOpen(false) }} aria-label="Close assistant">×</button></div>
      <p>Your story is the source. Assistant ideas stay separate until you choose to add them.</p>
      {!online && <p role="status">Remote Memory Assistant is unavailable offline. Your memory and local edits remain available.</p>}
      {!service.provider && <p role="status" className="assistant-unavailable">AI is not configured. Your memories and the rest of Life Line remain available.</p>}
      {service.provider?.kind === 'local' && <p role="status">Local assistant</p>}
      {service.provider?.kind === 'remote' && <div className="assistant-access" role="status">
        {remoteStatus === 'checking' && <p>Checking live assistant…</p>}
        {remoteStatus === 'ready' && <p>Live assistant ready <button type="button" className="quiet" onClick={() => { void signOutOfRemoteAI(remoteEndpoint).catch(() => undefined).finally(() => setRemoteStatus('authentication_required')) }}>Sign out</button></p>}
        {remoteStatus === 'mock' && <p>Local test assistant ready <button type="button" className="quiet" onClick={() => { void signOutOfRemoteAI(remoteEndpoint).catch(() => undefined).finally(() => setRemoteStatus('authentication_required')) }}>Sign out</button></p>}
        {remoteStatus === 'unavailable' && <p>Live assistant unavailable. Your memories remain available. <button type="button" onClick={() => { setRemoteStatus('checking'); getRemoteAIStatus(remoteEndpoint).then(setRemoteStatus) }}>Check again</button></p>}
        {remoteStatus === 'authentication_required' && <form onSubmit={event => { event.preventDefault(); void signIn() }}><label>Sign in to use live assistant <input type="password" value={accessPassword} autoComplete="current-password" onChange={event => setAccessPassword(event.target.value)}/></label><button type="submit" disabled={signingIn || !accessPassword}>Sign in</button></form>}
      </div>}
      <details className="assistant-context"><summary>Context being shared</summary>
        <p>Only this memory and the categories you select below. No image, video, or audio files are sent.</p>
        <p>This memory: “{context.memory.title}” ({context.memory.body.length} text characters); date metadata included.</p>
        <p>Related memories: {context.relatedMemories.length}; People names: {context.people.length}; Place names: {context.places.length}; tags: {context.tags.length}; Life Eras: {context.eras.length}; media metadata: {context.media.length}.</p>
        <p>Exact coordinates: {context.places.some(place => place.coordinates) ? 'included by your choice' : 'excluded'}. Estimated context: {estimateContextCharacters(context)} characters{context.truncated ? ' (trimmed to limit)' : ''}.</p>
        {relatedChoices.length > 0 && <fieldset><legend>Related memories to include</legend>{relatedChoices.map(related => <label key={related.id}><input type="checkbox" checked={selection.relatedIds.includes(related.id)} onChange={event => setSelection(value => ({ ...value, relatedIds: event.target.checked ? [...value.relatedIds, related.id] : value.relatedIds.filter(id => id !== related.id) }))}/>{related.title}</label>)}</fieldset>}
        {(['includePeople', 'includePlaces', 'includeTags', 'includeEras', 'includeMedia'] as const).map(key => <label key={key}><input type="checkbox" checked={selection[key]} onChange={event => setSelection(value => ({ ...value, [key]: event.target.checked }))}/>{({ includePeople: 'People names', includePlaces: 'Place names', includeTags: 'Tags', includeEras: 'Life Eras', includeMedia: 'Media metadata for questions' })[key]}</label>)}
        <label><input type="checkbox" checked={selection.includeExactCoordinates} onChange={event => setSelection(value => ({ ...value, includeExactCoordinates: event.target.checked }))}/>Include exact coordinates for this request</label>
      </details>
      <div className="assistant-actions">
        <button type="button" disabled={!service.provider || loading || (service.provider.kind === 'remote' && remoteStatus !== 'ready' && remoteStatus !== 'mock')} onClick={() => request('remember')}>Help me remember</button>
        <button type="button" disabled={!service.provider || loading || (service.provider.kind === 'remote' && remoteStatus !== 'ready' && remoteStatus !== 'mock')} onClick={() => request('connections')}>Suggest connections</button>
        <button type="button" disabled={!service.provider || loading || (service.provider.kind === 'remote' && remoteStatus !== 'ready' && remoteStatus !== 'mock')} onClick={() => request('organize')}>Organize this memory</button>
        <button type="button" disabled={!service.provider || loading || (service.provider.kind === 'remote' && remoteStatus !== 'ready' && remoteStatus !== 'mock')} onClick={() => request('write')}>Help me write</button>
      </div>
      {awaitingConsent && <div className="assistant-consent" role="alertdialog" aria-label="Remote AI privacy consent"><p>Using the Memory Assistant may send the selected memory and chosen context to the configured AI provider.</p><label><input type="checkbox" checked={rememberConsent} onChange={event => setRememberConsent(event.target.checked)}/>Remember my choice locally</label><div><button type="button" onClick={() => setAwaitingConsent(false)}>Cancel</button><button type="button" className="primary" onClick={() => { setSessionConsent(true); if (rememberConsent) saveRememberedConsent(); request(task, true) }}>Continue</button></div></div>}
      {loading && <p role="status">Preparing suggestions… <button type="button" onClick={() => controller.current?.abort()}>Cancel request</button></p>}
      {error && <p role="alert" className="assistant-error">{error} <button type="button" onClick={() => request(task)}>Retry</button></p>}
      {import.meta.env.DEV && service.provider === mockAIProvider && <button type="button" className="assistant-test-failure" disabled={loading} onClick={() => { failNextMockRequest(); request(task) }}>Simulate request failure</button>}
      {suggestions.map(item => <article className="assistant-suggestion" key={item.id}>
        <span className="eyebrow">AI SUGGESTION · {item.type} · {item.status}</span>
        {item.type === 'draft' && <><h4>Original</h4><p className="assistant-original">{entry.body || 'No story text yet.'}</p><h4>AI Draft</h4></>}
        <p>{item.content.text}</p>
        {item.content.reason && <small>{item.content.reason}</small>}
        {(item.type === 'person' || item.type === 'place') && !canAccept(item) && <small>Not matched to an existing record. Confirm or create it manually in People or Places first.</small>}
        {item.type === 'date' && item.content.proposedDate && <small>Possible date: {item.content.proposedDate.start ?? 'unknown'} · {item.content.proposedDate.precision} · {item.content.reason ?? 'Review evidence before moving.'}</small>}
        <small>From {item.provider}{item.model ? ` / ${item.model}` : ''} · {new Date(item.createdAt).toLocaleString()} · {item.contextReferences.categories.join(', ')}</small>
        {item.status === 'pending' && <div className="assistant-suggestion-actions">
          {item.type === 'draft' ? <><button type="button" onClick={() => accept(item, 'insert')}>Insert below</button><button type="button" onClick={() => accept(item, 'replace')}>Replace text</button><button type="button" onClick={() => navigator.clipboard.writeText(item.content.text).catch(() => setError('Copy failed.'))}>Copy</button><button type="button" onClick={() => setStatus(item.id, 'rejected')}>Discard</button></>
            : item.type === 'date' ? <><button type="button" disabled={!onReviewDate} onClick={onReviewDate}>Review date in move dialog</button><button type="button" onClick={() => setStatus(item.id, 'rejected')}>Reject</button></>
              : item.type === 'question' ? <button type="button" onClick={() => setStatus(item.id, 'rejected')}>Dismiss question</button>
                : <>{canAccept(item) && <button type="button" onClick={() => accept(item)}>Accept</button>}<button type="button" onClick={() => setStatus(item.id, 'rejected')}>Reject</button></>}
        </div>}
      </article>)}
      {suggestions.some(item => item.type === 'question' && item.status === 'pending') && <div className="assistant-answer"><label>Your answer stays a draft until you add it to the memory.<textarea value={answer} onChange={event => setAnswer(event.target.value)} rows={3}/></label><div><button type="button" disabled={!answer.trim()} onClick={addAnswer}>Add this to my memory</button><button type="button" disabled={loading} onClick={() => request('remember')}>Next question</button></div></div>}
    </section>}
  </div>
}
