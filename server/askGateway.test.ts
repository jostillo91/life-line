import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { deriveAskHints, selectAskEvidence, type AskAnswer } from '../src/askDomain'
import { seed } from '../src/seed'
import { createAssistantAPI, RequestLimiter } from './assistantApi'
import { parseAskInput, parseAskOutput } from './askContract'
import { createOpenAIAskGateway } from './askGateway'
import { PrivateAccess } from './privateAccess'

const evidence = selectAskEvidence(seed, 'What happened in 2010?', deriveAskHints('What happened in 2010?', seed))
const payload = { question: 'What happened in 2010?', evidence }
const answer: AskAnswer = { sufficiency: 'partial', claims: [{ statement: 'A memory records a move to Phoenix in 2010.', sourceMemoryIds: ['m-move'] }], sourceMemoryIds: ['m-move'], unresolvedQuestions: [] }
const origin = 'https://diary.example'
const access = new PrivateAccess('a test-only long private password')
const cookie = access.signIn('a test-only long private password')!.cookie.split(';')[0]
const req = (body: unknown, auth = true, requestOrigin = origin) => new Request('http://localhost/api/memory-assistant/ask', { method: 'POST',
  headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) })

describe('Ask server contract', () => {
  it('accepts bounded canonical evidence but rejects GPS, binaries, unknown fields, and excessive items', () => {
    expect(parseAskInput(payload).evidence).toEqual(evidence)
    for (const invalid of [
      { ...payload, evidence: [...evidence, ...evidence, ...evidence, ...evidence, ...evidence, ...evidence] },
      { ...payload, evidence: [{ ...evidence[0], latitude: 33.5 }] },
      { ...payload, evidence: [{ ...evidence[0], mediaIds: ['secret'] }] },
      { ...payload, evidence: [{ ...evidence[0], body: 'x'.repeat(851) }] },
    ]) expect(() => parseAskInput(invalid)).toThrow()
  })

  it('rejects fabricated citations and malformed claims even after structured output', () => {
    expect(parseAskOutput(JSON.stringify(answer), evidence)).toEqual(answer)
    expect(() => parseAskOutput(JSON.stringify({ ...answer, claims: [{ ...answer.claims[0], sourceMemoryIds: ['fake'] }] }), evidence)).toThrow()
    expect(() => parseAskOutput(JSON.stringify({ ...answer, claims: [{ statement: 'Uncited', sourceMemoryIds: [] }] }), evidence)).toThrow()
  })

  it('uses the configured Responses model, strict schema, bounded output, no tools or provider storage', async () => {
    const create = vi.fn(async (_params: unknown) => ({ status: 'completed', output_text: JSON.stringify(answer), model: 'gpt-5.6-terra', usage: { input_tokens: 100, output_tokens: 40 } }))
    const gateway = createOpenAIAskGateway('test-only-key', 'gpt-5.6-terra', { responses: { create } } as unknown as OpenAI)
    expect((await gateway(payload, new AbortController().signal)).answer).toEqual(answer)
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.6-terra', store: false, tools: [], tool_choice: 'none', max_output_tokens: 1100,
      text: { format: { type: 'json_schema', strict: true, name: 'life_line_grounded_answer' } } })
    expect(JSON.stringify(create.mock.calls[0])).not.toContain(seed.entries[0].body)
  })

  it('requires an authenticated exact-origin session, shares limits, and rejects invented model sources', async () => {
    const ask = vi.fn(async () => ({ answer, metadata: { model: 'mock' } }))
    const api = createAssistantAPI({ allowedOrigin: origin, access, ask })
    expect((await api(req(payload, false), 'client')).status).toBe(401)
    expect((await api(req(payload, true, 'https://other.example'), 'client')).status).toBe(403)
    expect(ask).not.toHaveBeenCalled()
    expect((await api(req(payload), 'client')).status).toBe(200)
    const limited = createAssistantAPI({ allowedOrigin: origin, access, ask, limiter: new RequestLimiter(1, 1, 1) })
    expect((await limited(req(payload), 'client')).status).toBe(200)
    expect((await limited(req(payload), 'client')).status).toBe(429)
    const malicious = createAssistantAPI({ allowedOrigin: origin, access, ask: async () => ({ answer: { ...answer, sourceMemoryIds: ['fabricated'] }, metadata: { model: 'mock' } }) })
    expect((await malicious(req(payload), 'client')).status).toBe(502)
    expect((await api(req({ ...payload, evidence: [{ ...evidence[0], latitude: 33.5 }] }), 'client')).status).toBe(400)
  })
})
