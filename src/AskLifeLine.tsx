import { useEffect, useMemo, useRef, useState } from 'react'
import { dateDescriptionConflicts, isEvidenceCurrent, localEvidence, type AskAnswer, type AskEvidence } from './askDomain'
import { createRemoteAskProvider, mockAskProvider } from './askProvider'
import { AskLifeLineService } from './askService'
import { getRemoteAIStatus, signInToRemoteAI, type RemoteAIStatus } from './remoteAISession'
import { aiEndpoint, embeddingProvider, semanticService } from './searchRuntime'
import type { SearchFilters } from './semanticSearch'
import type { Archive, Entry } from './types'
import { useOnline } from './networkState'

const answerProvider = import.meta.env.VITE_LIFE_LINE_AI_MODE === 'openai'
  ? createRemoteAskProvider(aiEndpoint)
  : import.meta.env.VITE_LIFE_LINE_AI_MODE === 'mock' || (import.meta.env.DEV && !import.meta.env.VITE_LIFE_LINE_AI_MODE)
    ? mockAskProvider : undefined
const askService = new AskLifeLineService(answerProvider, semanticService)
const consentKey = 'life-line:remote-ai-consent'
const remembered = () => { try { return localStorage.getItem(consentKey) === 'yes' } catch { return false } }

type Turn = { question: string; evidence: AskEvidence[]; answer?: AskAnswer; warning?: string; error?: string; semanticUsed: boolean }

export function AskLifeLine({ data, filters, seedQuestion, onOpenMemory, onViewTimeline }: {
  data: Archive; filters: SearchFilters; seedQuestion?: string; onOpenMemory: (entry: Entry) => void; onViewTimeline: (entry: Entry) => void
}) {
  const online = useOnline()
  const [question, setQuestion] = useState(seedQuestion ?? '')
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, setPending] = useState<Turn>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [consent, setConsent] = useState(remembered)
  const [rememberConsent, setRememberConsent] = useState(false)
  const [status, setStatus] = useState<RemoteAIStatus>('unavailable')
  const [password, setPassword] = useState('')
  const controller = useRef<AbortController | null>(null)
  const previousQuestion = turns.at(-1)?.question
  useEffect(() => { if (seedQuestion) setQuestion(seedQuestion) }, [seedQuestion])
  useEffect(() => { if (answerProvider?.kind === 'remote') {if(online) void getRemoteAIStatus(aiEndpoint).then(setStatus);else {controller.current?.abort();setStatus('unavailable')}}; return () => controller.current?.abort() }, [online])

  async function retrieve() {
    const clean = question.trim()
    if (!clean || clean.length > 300 || busy) return
    const active = new AbortController(); controller.current = active; setBusy(true); setError(''); setPending(undefined)
    try {
      const result = await askService.retrieve(data, clean, filters, active.signal, previousQuestion)
      setPending({ question: clean, ...result })
      setQuestion('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not search your archive.') }
    finally { controller.current = null; setBusy(false) }
  }

  async function answer() {
    if (!pending || busy || !pending.evidence.length) return
    if (!online && answerProvider?.kind === 'remote') {setError('Ask Life Line synthesis is unavailable offline. Your retrieved sources remain available.');return}
    const active = new AbortController(); controller.current = active; setBusy(true); setError('')
    try {
      const generated = await askService.answer(pending.question, pending.evidence, active.signal, previousQuestion)
      if (answerProvider?.kind === 'remote' && rememberConsent) { try { localStorage.setItem(consentKey, 'yes') } catch { /* current consent remains */ } }
      setConsent(true)
      setTurns(value => [...value, { ...pending, answer: generated }].slice(-6)); setPending(undefined)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'AI answer service is unavailable.'
      setError(message)
      if (message.includes('Sign in')) setStatus('authentication_required')
    } finally { controller.current = null; setBusy(false) }
  }

  async function signIn() {
    try { setStatus(await signInToRemoteAI(aiEndpoint, password)); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in.') }
    finally { setPassword('') }
  }

  const displayed = useMemo(() => pending ? [...turns, pending] : turns, [turns, pending])
  return <section className="ask-life-line">
    <p>Ask Life Line searches your Memories first, then offers an answer grounded in the sources below. It cannot determine facts that are not recorded.</p>
    {!online && <p role="status">AI synthesis is unavailable offline. Find sources still searches your local archive.</p>}
    <form className="search-query" onSubmit={event => { event.preventDefault(); void retrieve() }}>
      <input aria-label="Ask your life" placeholder="Ask your life..." value={question} maxLength={300} onChange={event => setQuestion(event.target.value)}/>
      <button className="primary" disabled={!question.trim() || busy}>Find sources</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => { setTurns([]); setPending(undefined); setQuestion(''); setError('') }}>New question</button>
    </form>
    <p className="ask-help">Filters below narrow retrieval locally. Semantic retrieval uses the existing opt-in index when available; otherwise Ask uses keyword and archive relationships.</p>
    {busy && <button type="button" onClick={() => controller.current?.abort()}>Cancel</button>}
    {error && <p role="alert" className="assistant-error">{error} {pending?.evidence.length ? 'You can still inspect the sources below.' : ''}</p>}
    {displayed.map((turn, turnIndex) => <article className="ask-turn" key={turnIndex}>
      <h3>{turn.question}</h3>
      {turn.warning && <p className="ask-help">{turn.warning}</p>}
      {!turn.evidence.length ? <p role="status">I couldn’t find enough in your Life Line to answer that reliably. Try another question or adjust the filters.</p> : <>
        {turn.answer && turn.evidence.every(item => isEvidenceCurrent(data, item)) ? <div className="ask-answer" role="status">
          {turn.answer.sufficiency !== 'sufficient' && <p>{turn.answer.sufficiency === 'insufficient' ? 'I couldn’t find enough in your Life Line to answer that reliably.' : 'This is a partial answer; the archive may not tell the whole story.'}</p>}
          {turn.answer.claims.map((claim, index) => <p key={index}>{claim.statement} {claim.sourceMemoryIds.map(id => {
            const source = turn.evidence.find(item => item.memoryId === id)
            const original = data.entries.find(item => item.id === id)
            const number = turn.evidence.findIndex(item => item.memoryId === id) + 1
            return source && original ? <button type="button" className="ask-citation" key={id} onClick={() => onOpenMemory(original)} aria-label={`Open source ${number}: ${source.title}`}>[{number}]</button> : null
          })}</p>)}
          {turn.answer.unresolvedQuestions.length > 0 && <p>Still unclear: {turn.answer.unresolvedQuestions.join(' ')}</p>}
        </div> : <p>{turn.answer ? 'A source has changed since this answer was generated. Ask again to refresh its citations.' : turnIndex === displayed.length - 1 && pending ? 'Sources found. Review what will be shared before asking for an answer.' : 'Sources found.'}</p>}
        {dateDescriptionConflicts(turn.evidence).map(([left, right]) => <p className="ask-conflict" key={`${left.memoryId}:${right.memoryId}`}>Possible date conflict: two sources titled “{left.title}” describe their dates as “{left.date}” and “{right.date}”. Inspect both; Life Line has not resolved them.</p>)}
        <details open={turnIndex === displayed.length - 1} className="ask-sources"><summary>Sources being shared · {turn.evidence.length} {turn.evidence.length === 1 ? 'Memory' : 'Memories'}</summary>
          {turnIndex === displayed.length - 1 && pending && <p>The question and approximately {JSON.stringify(turn.evidence).length.toLocaleString()} characters of selected Memory text/metadata will be sent for answer synthesis. People/Places: {[...new Set(turn.evidence.flatMap(item => [...item.people, ...item.places]))].join(', ') || 'none'}. No raw GPS or media files.</p>}
          <ol>{localEvidence(data, turn.evidence).map(source => <li key={source.entry.id}><strong>{source.entry.title}</strong> — {source.date} ({source.entry.eventDate.precision}, {source.entry.eventDate.confidence})<p>{source.excerpt}</p><div><button type="button" onClick={() => onOpenMemory(source.entry)}>Open Memory</button><button type="button" onClick={() => onViewTimeline(source.entry)}>View on Timeline</button></div></li>)}</ol>
        </details>
        {pending === turn && <div className="ask-consent">
          {answerProvider?.kind === 'remote' && <p>Continue sends only this question and the sources above to the configured AI provider. The existing remote-AI session and consent apply.</p>}
          {answerProvider?.kind === 'remote' && status === 'authentication_required' && <form onSubmit={event => { event.preventDefault(); void signIn() }}><label>AI access password <input type="password" value={password} onChange={event => setPassword(event.target.value)}/></label><button disabled={!password}>Sign in</button></form>}
          {answerProvider?.kind === 'remote' && !consent && <label><input type="checkbox" checked={rememberConsent} onChange={event => setRememberConsent(event.target.checked)}/> Remember my consent locally</label>}
          <button type="button" className="primary" disabled={busy || !answerProvider || (answerProvider.kind === 'remote' && status !== 'ready' && status !== 'mock')} onClick={() => void answer()}>{answerProvider ? 'Continue and answer' : 'AI answer service unavailable'}</button>
        </div>}
      </>}
    </article>)}
    {answerProvider?.kind === 'remote' && status === 'unavailable' && <p className="ask-help">AI answer service is unavailable. Retrieved sources remain available. <button type="button" onClick={() => void getRemoteAIStatus(aiEndpoint).then(setStatus)}>Check service again</button></p>}
    {!embeddingProvider && <p className="ask-help">Semantic indexing is unavailable here; keyword and structured retrieval still work.</p>}
  </section>
}
