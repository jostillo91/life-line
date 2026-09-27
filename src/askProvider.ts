import { validAskAnswer, type AskAnswer, type AskEvidence } from './askDomain'
import { requireOnline } from './networkState'

export interface AskRequest { question: string; evidence: AskEvidence[]; previousQuestion?: string }
export interface AskProvider { kind: 'local' | 'remote'; answer(input: AskRequest, signal: AbortSignal): Promise<AskAnswer> }

export function mockAskAnswer(input: AskRequest): AskAnswer {
  const evidence = input.evidence.slice(0, 2)
  return { sufficiency: 'partial', claims: evidence.map(item => ({
    statement: `Life Line has “${item.title}” (${item.date}; ${item.eventDate.precision}, ${item.eventDate.confidence}).`, sourceMemoryIds: [item.memoryId],
  })), sourceMemoryIds: evidence.map(item => item.memoryId), unresolvedQuestions: [] }
}

export const mockAskProvider: AskProvider = { kind: 'local', async answer(input, signal) {
  if (signal.aborted) throw new Error('Question cancelled.')
  return mockAskAnswer(input)
} }

export function createRemoteAskProvider(endpoint = '/api/memory-assistant', fetcher: typeof fetch = fetch): AskProvider {
  return { kind: 'remote', async answer(input, signal) {
    requireOnline('Ask Life Line synthesis')
    let response: Response
    try { response = await fetcher(`${endpoint.replace(/\/$/, '')}/ask`, { method: 'POST', credentials: 'include', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }
    catch { throw new Error(signal.aborted ? 'Question cancelled.' : 'AI answer service is unavailable.') }
    if (response.status === 401) throw new Error('Sign in to use Ask Life Line.')
    if (response.status === 429) throw new Error('AI answer service is rate limited. Try again shortly.')
    if (!response.ok) throw new Error('AI answer service is unavailable.')
    let body: unknown
    try { body = await response.json() } catch { throw new Error('AI answer service returned an unusable answer.') }
    const answer = body && typeof body === 'object' ? (body as { answer?: unknown }).answer : undefined
    if (!validAskAnswer(answer, input.evidence)) throw new Error('AI answer service returned an unusable answer.')
    return answer
  } }
}
