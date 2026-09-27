import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { buildAIContext, defaultContextSelection } from '../src/assistantDomain'
import { seed } from '../src/seed'
import { createAssistantAPI, RequestLimiter } from './assistantApi'
import { ContractError, parseAssistantInput, parseModelOutput } from './assistantContract'
import { createOpenAIGateway, ProviderError } from './openaiGateway'
import { PrivateAccess } from './privateAccess'
import { readServerConfig } from './config'

const selected = seed.entries[0]
const context = buildAIContext('remember', selected, seed, defaultContextSelection())
const payload = { task: 'remember', context, questionIndex: 0 }
const endpoint = 'http://localhost/api/memory-assistant'
const password = 'a long private test password'
const access = new PrivateAccess(password, 480, true)
const cookie = access.signIn(password)!.cookie.split(';')[0]
const request = (body: unknown, origin = 'https://diary.example', sessionCookie = cookie) => new Request(endpoint, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify(body),
})
const fakeResult = { suggestions: [{ type: 'question' as const, content: { text: 'Who was there?' } }], metadata: { model: 'gpt-5.6-terra', providerRequestId: 'req-provider', usage: { inputTokens: 100, outputTokens: 20 } } }

describe('server AI contract', () => {
  it('accepts only the selected context and excludes unrelated entries and GPS', () => {
    const parsed = parseAssistantInput(payload)
    expect(parsed.context.memory.id).toBe(selected.id)
    expect(parsed.context.relatedMemories).toEqual([])
    expect(JSON.stringify(parsed.context)).not.toContain(seed.entries[4].body)
    expect(JSON.stringify(parsed.context)).not.toContain('latitude')
  })

  it('rejects unsupported tasks, oversized context, and unexpected media fields', () => {
    expect(() => parseAssistantInput({ ...payload, task: 'searchArchive' })).toThrow(ContractError)
    expect(() => parseAssistantInput({ ...payload, context: { ...context, memory: { ...context.memory, body: 'x'.repeat(7000) } } })).toThrow(ContractError)
    expect(() => parseAssistantInput({ ...payload, context: { ...context, media: [{ id: 'm', filename: 'x', storageKey: 'secret' }] } })).toThrow(ContractError)
  })

  it('validates structured output and rejects invented entity IDs', () => {
    expect(() => parseModelOutput('remember', '{bad', context)).toThrow(ContractError)
    expect(() => parseModelOutput('remember', JSON.stringify({ questions: [{ text: 'One?' }, { text: 'Two?' }] }), context)).toThrow(ContractError)
    const connectionContext = buildAIContext('connections', { ...selected, body: 'Dad and Phoenix were there.', peopleIds: [], placeIds: [] }, seed, defaultContextSelection())
    const item = { kind: 'existingPerson', text: 'Dad may be relevant', targetId: 'fabricated', reason: 'Named in story' }
    expect(() => parseModelOutput('connections', JSON.stringify({ suggestions: [item] }), connectionContext)).toThrow(ContractError)
    expect(parseModelOutput('connections', JSON.stringify({ suggestions: [{ ...item, targetId: 'p-dad' }] }), connectionContext)[0]).toMatchObject({ type: 'person', content: { targetId: 'p-dad' } })
    const unknown = { kind: 'possibleUnknownPerson', text: 'Was someone else there?', targetId: null, reason: null }
    expect(parseModelOutput('connections', JSON.stringify({ suggestions: [unknown] }), connectionContext)[0].type).toBe('question')
  })

  it('keeps date proposals uncertain and rejects fabricated exact certainty', () => {
    const item = { kind: 'possibleDate', text: 'Possibly 2004', targetId: null, reason: 'Another memory mentions 2004', value: null, proposedDate: { precision: 'year', start: '2004-01-01', end: null } }
    expect(parseModelOutput('organize', JSON.stringify({ suggestions: [item] }), context)[0]).toMatchObject({ type: 'date', content: { proposedDate: { confidence: 'guess' } } })
    expect(() => parseModelOutput('organize', JSON.stringify({ suggestions: [{ ...item, proposedDate: { ...item.proposedDate, precision: 'exact' } }] }), context)).toThrow(ContractError)
  })
})

describe('OpenAI gateway', () => {
  it('maps a task to the Responses API with schema, no tools, no storage, and bounded output', async () => {
    const create = vi.fn(async () => ({ status: 'completed', output_text: JSON.stringify({ questions: [{ text: 'Who was there?' }] }), model: 'gpt-5.6-terra', _request_id: 'req-provider', usage: { input_tokens: 100, output_tokens: 20 } }))
    const gateway = createOpenAIGateway('server-test-key', undefined, { responses: { create } } as unknown as OpenAI)
    const result = await gateway(parseAssistantInput(payload), new AbortController().signal)
    expect(result).toEqual(fakeResult)
    const [params, options] = create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>]
    expect(params).toMatchObject({ model: 'gpt-5.6-terra', store: false, tools: [], tool_choice: 'none', max_output_tokens: 800 })
    expect(params.text).toMatchObject({ format: { type: 'json_schema', strict: true, name: 'life_line_questions' } })
    expect(options).toMatchObject({ maxRetries: 0, timeout: 15000 })
    expect(String(params.input)).not.toContain(seed.entries[4].body)
    expect(String(params.input)).not.toContain('latitude')
  })

  it('maps authentication, rate-limit, timeout, and malformed provider results safely', async () => {
    const make = (create: () => Promise<unknown>) => createOpenAIGateway('test', undefined, { responses: { create } } as unknown as OpenAI)
    await expect(make(async () => { throw { status: 401, message: 'private detail' } })(parseAssistantInput(payload), new AbortController().signal)).rejects.toMatchObject({ code: 'authentication', status: 503 })
    await expect(make(async () => { throw { status: 429 } })(parseAssistantInput(payload), new AbortController().signal)).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    await expect(make(async () => ({ status: 'completed', output_text: '{bad' }))(parseAssistantInput(payload), new AbortController().signal)).rejects.toBeInstanceOf(ContractError)
    const aborted = new AbortController()
    aborted.abort()
    await expect(make(async () => { throw Error('aborted') })(parseAssistantInput(payload), aborted.signal)).rejects.toEqual(new ProviderError('timeout', 504))
  })
})

describe('HTTP API boundary', () => {
  it('returns only validated suggestions and minimal operational metadata', async () => {
    const generate = vi.fn(async () => fakeResult)
    const log = vi.fn()
    const api = createAssistantAPI({ allowedOrigin: 'https://diary.example', access, generate, log })
    const response = await api(request(payload), 'test-client')
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://diary.example')
    expect(await response.json()).toMatchObject({ suggestions: fakeResult.suggestions, metadata: { model: 'gpt-5.6-terra', usage: fakeResult.metadata.usage } })
    expect(log.mock.calls[0][0]).toMatchObject({ task: 'remember', outcome: 'success', inputTokens: 100 })
    expect(JSON.stringify(log.mock.calls)).not.toContain(selected.body)
  })

  it('rejects wrong origins, methods, content types, oversized requests, and missing provider', async () => {
    const generate = vi.fn(async () => fakeResult)
    const api = createAssistantAPI({ allowedOrigin: 'https://diary.example', access, generate })
    expect((await api(request(payload, 'https://other.example'), 'a')).status).toBe(403)
    expect((await api(new Request(endpoint, { method: 'GET', headers: { Cookie: cookie } }), 'a')).status).toBe(405)
    expect((await api(new Request(endpoint, { method: 'POST', headers: { Origin: 'https://diary.example', Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' }), 'a')).status).toBe(415)
    expect((await api(request({ ...payload, extra: 'x'.repeat(11000) }), 'a')).status).toBe(413)
    expect((await createAssistantAPI({ allowedOrigin: 'https://diary.example', access })(request(payload), 'a')).status).toBe(503)
    expect(generate).not.toHaveBeenCalled()
  })

  it('limits each client and concurrent requests without a provider call', async () => {
    const limiter = new RequestLimiter()
    const releases = Array.from({ length: 6 }, (_, index) => limiter.enter(`client-${index}`))
    expect(releases[0]).not.toBeNull()
    expect(releases[1]).not.toBeNull()
    expect(releases[2]).toBeNull()
    releases[0]?.(); releases[1]?.()
    const generate = vi.fn(async () => fakeResult)
    const api = createAssistantAPI({ allowedOrigin: 'https://diary.example', access, generate, limiter: new RequestLimiter() })
    for (let index = 0; index < 6; index++) expect((await api(request(payload), 'same-client')).status).toBe(200)
    expect((await api(request(payload), 'same-client')).status).toBe(429)
    expect(generate).toHaveBeenCalledTimes(6)
  })

  it('rejects unauthenticated, expired, and wrong-origin requests before generation', async () => {
    const generate = vi.fn(async () => fakeResult)
    const api = createAssistantAPI({ allowedOrigin: 'https://diary.example', access, generate })
    expect((await api(request(payload, 'https://diary.example', ''), 'one')).status).toBe(401)
    expect((await api(request(payload, 'https://evil.example'), 'one')).status).toBe(403)
    expect((await api(new Request(endpoint, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), 'one')).status).toBe(403)
    const shortAccess = new PrivateAccess(password, 5, true)
    const expired = shortAccess.signIn(password, Date.now() - 6 * 60_000)!.cookie.split(';')[0]
    const shortApi = createAssistantAPI({ allowedOrigin: 'https://diary.example', access: shortAccess, generate })
    expect((await shortApi(request(payload, 'https://diary.example', expired), 'one')).status).toBe(401)
    expect(generate).not.toHaveBeenCalled()
  })

  it('issues a secure short-lived cookie and exposes safe readiness and diagnostics', async () => {
    const api = createAssistantAPI({ allowedOrigin: 'https://diary.example', access, generate: async () => fakeResult })
    const health = await api(new Request(`${endpoint}/health`), 'one')
    const healthBody = await health.text()
    expect(JSON.parse(healthBody)).toEqual({ ok: true })
    expect(JSON.stringify(await (await api(new Request(`${endpoint}/status`), 'one')).json())).not.toContain('ready')
    const login = await api(new Request(`${endpoint}/session`, { method: 'POST', headers: { Origin: 'https://diary.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }), 'one')
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict')
    const issuedCookie = login.headers.get('set-cookie')!.split(';')[0]
    const status = await api(new Request(`${endpoint}/status`, { headers: { Cookie: issuedCookie } }), 'one')
    expect(await status.json()).toMatchObject({ status: 'ready', embedding: { status: 'unavailable' } })
    const diagnostic = await api(new Request(`${endpoint}/diagnostics`, { headers: { Cookie: issuedCookie } }), 'one')
    expect(await diagnostic.json()).toMatchObject({ requests: 0, inputTokens: 0 })
    expect(healthBody).not.toContain(password)
  })

  it('labels the explicitly selected development mock instead of presenting it as live OpenAI', async () => {
    const api = createAssistantAPI({ allowedOrigin: 'https://diary.example', access, mockMode: true, generate: async () => fakeResult })
    const response = await api(new Request(`${endpoint}/status`, { headers: { Cookie: cookie } }), 'one')
    expect(await response.json()).toMatchObject({ status: 'mock' })
  })

  it('enforces global and concurrency limits independently of the client', () => {
    const limiter = new RequestLimiter(5, 2, 1)
    const first = limiter.enter('one', 100_000)
    expect(first).not.toBeNull()
    expect(limiter.enter('two', 100_000)).toBeNull()
    first?.()
    const second = limiter.enter('two', 100_000)
    expect(second).not.toBeNull()
    second?.()
    expect(limiter.enter('three', 100_000)).toBeNull()
  })
})

describe('production configuration', () => {
  it('cannot enable mock or insecure origins in production', () => {
    const base = { NODE_ENV: 'production', LIFE_LINE_AI_ACCESS_PASSWORD: password, LIFE_LINE_AI_ALLOWED_ORIGIN: 'https://diary.example' }
    expect(() => readServerConfig({ ...base, LIFE_LINE_AI_PROVIDER: 'mock' })).toThrow()
    expect(() => readServerConfig({ ...base, LIFE_LINE_AI_ALLOWED_ORIGIN: 'http://diary.example' })).toThrow()
    expect(() => readServerConfig({ ...base, LIFE_LINE_AI_ACCESS_PASSWORD: '' })).toThrow()
    expect(() => readServerConfig({ ...base, LIFE_LINE_AI_ACCESS_PASSWORD: 'replace-with-a-long-unique-private-password' })).toThrow()
    expect(() => readServerConfig({ ...base, LIFE_LINE_AI_MAX_BODY_BYTES: '20000' })).toThrow()
    expect(readServerConfig(base)).toMatchObject({ production: true, mock: false, model: 'gpt-5.6-terra' })
  })
})
