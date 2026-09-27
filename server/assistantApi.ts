import { ContractError, parseAssistantInput, type AssistantInput } from './assistantContract.ts'
import { ProviderError, type GenerationResult } from './openaiGateway.ts'
import { PrivateAccess } from './privateAccess.ts'
import type { EmbeddingResult } from './embeddingGateway.ts'
import { parseAskInput, type AskInput } from './askContract.ts'
import { validAskAnswer, type AskAnswer } from '../src/askDomain.ts'

type Generate = (input: AssistantInput, signal: AbortSignal) => Promise<GenerationResult>
type Ask = (input: AskInput, signal: AbortSignal) => Promise<{ answer: AskAnswer; metadata: GenerationResult['metadata'] }>
type LogEvent = { requestId: string; sessionId?: string; task?: string; durationMs: number; outcome: string; providerRequestId?: string; inputTokens?: number; outputTokens?: number }
const BASE = '/api/memory-assistant'
class PayloadTooLargeError extends Error {}

export interface ApiLimits { maxBodyBytes: number; perSessionPerMinute: number; globalPerMinute: number; maxConcurrent: number }
export const DEFAULT_LIMITS: ApiLimits = { maxBodyBytes: 10_000, perSessionPerMinute: 6, globalPerMinute: 30, maxConcurrent: 2 }

export class RequestLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()
  private global = { start: 0, count: 0 }
  private active = 0
  private readonly perClient: number
  private readonly globalPerMinute: number
  private readonly maxConcurrent: number

  constructor(perClient = 6, globalPerMinute = 30, maxConcurrent = 2) {
    this.perClient = perClient
    this.globalPerMinute = globalPerMinute
    this.maxConcurrent = maxConcurrent
  }

  enter(clientId: string, now = Date.now()): (() => void) | null {
    const previous = this.windows.get(clientId)
    const current = previous && now - previous.start < 60_000 ? previous : { start: now, count: 0 }
    if (now - this.global.start >= 60_000) this.global = { start: now, count: 0 }
    if (current.count >= this.perClient || this.global.count >= this.globalPerMinute || this.active >= this.maxConcurrent) return null
    current.count += 1
    this.global.count += 1
    this.windows.set(clientId, current)
    this.active += 1
    if (this.windows.size > 1000) for (const [id, value] of this.windows) if (now - value.start >= 60_000) this.windows.delete(id)
    return () => { this.active = Math.max(0, this.active - 1) }
  }
}

export function createAssistantAPI(options: {
  allowedOrigin: string
  access: PrivateAccess
  generate?: Generate
  embed?: (texts: string[], signal: AbortSignal) => Promise<EmbeddingResult>
  ask?: Ask
  embeddingInfo?: { model: string; dimension: number }
  mockMode?: boolean
  limits?: ApiLimits
  limiter?: RequestLimiter
  log?: (event: LogEvent) => void
}) {
  const limits = options.limits ?? DEFAULT_LIMITS
  const limiter = options.limiter ?? new RequestLimiter(limits.perSessionPerMinute, limits.globalPerMinute, limits.maxConcurrent)
  const loginLimiter = new RequestLimiter(5, 30, 30)
  const totals = { requests: 0, successes: 0, failures: 0, rateLimits: 0, inputTokens: 0, outputTokens: 0, embeddingRequests: 0, embeddingInputTokens: 0, askRequests: 0 }
  return async (request: Request, clientId: string): Promise<Response> => {
    const started = Date.now()
    const suppliedId = request.headers.get('x-life-line-request-id')
    const requestId = suppliedId && /^[a-zA-Z0-9-]{1,64}$/.test(suppliedId) ? suppliedId : crypto.randomUUID()
    const origin = request.headers.get('origin')
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Life-Line-Request-Id': requestId, Vary: 'Origin',
    }
    if (origin && origin !== options.allowedOrigin) return json(403, { error: { code: 'invalid_request' } }, headers)
    if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers['Access-Control-Allow-Credentials'] = 'true' }
    const path = new URL(request.url).pathname
    if (![BASE, `${BASE}/session`, `${BASE}/status`, `${BASE}/health`, `${BASE}/diagnostics`, `${BASE}/embed`, `${BASE}/ask`].includes(path)) return json(404, { error: { code: 'invalid_request' } }, headers)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Life-Line-Request-Id' } })
    if (request.method !== 'GET' && !origin) return json(403, { error: { code: 'invalid_request' } }, headers)
    if (path === `${BASE}/health` && request.method === 'GET') return json(200, { ok: true }, headers)
    const cookie = request.headers.get('cookie')
    const session = options.access.get(cookie)
    if (path === `${BASE}/session` && request.method === 'POST') {
      const release = loginLimiter.enter(clientId)
      if (!release) return json(429, { error: { code: 'rate_limited' } }, { ...headers, 'Retry-After': '60' })
      release()
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) return json(415, { error: { code: 'invalid_request' } }, headers)
      try {
        const body = await readJson(request, Math.min(512, limits.maxBodyBytes))
        if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.password !== 'string' || body.password.length > 256) throw new ContractError('invalid_request')
        const signedIn = options.access.signIn(body.password)
        if (!signedIn) return json(401, { error: { code: 'authentication_required' } }, headers)
        return json(200, { status: options.mockMode ? 'mock' : options.generate ? 'ready' : 'unavailable', embedding: embeddingStatus(options) }, { ...headers, 'Set-Cookie': signedIn.cookie })
      } catch (error) {
        return json(error instanceof PayloadTooLargeError ? 413 : error instanceof ContractError ? 400 : 500, { error: { code: 'invalid_request' } }, headers)
      }
    }
    if (path === `${BASE}/session` && request.method === 'DELETE') return json(200, { status: 'authentication_required' }, { ...headers, 'Set-Cookie': options.access.signOut(cookie) })
    if (!session) return json(401, { error: { code: 'authentication_required' } }, headers)
    if (path === `${BASE}/status` && request.method === 'GET') return json(200, { status: options.mockMode ? 'mock' : options.generate ? 'ready' : 'unavailable', embedding: embeddingStatus(options) }, headers)
    if (path === `${BASE}/diagnostics` && request.method === 'GET') return json(200, { ...totals }, headers)
    if (path === `${BASE}/embed` && request.method === 'POST') {
      totals.embeddingRequests += 1
      let outcome = 'server_error'; let providerRequestId: string | undefined; let inputTokens: number | undefined; let task: string | undefined
      let release: (() => void) | null = null
      try {
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) return json(415, { error: { code: 'invalid_request' } }, headers)
        if (!options.embed) { outcome = 'unavailable'; return json(503, { error: { code: 'unavailable' } }, headers) }
        release = limiter.enter(session.id)
        if (!release) { outcome = 'rate_limited'; totals.rateLimits++; return json(429, { error: { code: 'rate_limited' } }, { ...headers, 'Retry-After': '60' }) }
        const input = parseEmbeddingInput(await readJson(request, limits.maxBodyBytes))
        task = `embedding:${input.kind}`
        const result = await options.embed(input.texts, request.signal)
        if (result.vectors.length !== input.texts.length || result.vectors.some(vector => vector.length !== result.dimension || vector.some(value => !Number.isFinite(value)))) throw new ProviderError('server_error', 502)
        if (options.embeddingInfo && (result.model !== options.embeddingInfo.model || result.dimension !== options.embeddingInfo.dimension)) throw new ProviderError('server_error', 502)
        outcome = 'success'; totals.successes++; providerRequestId = result.providerRequestId
        inputTokens = result.usage?.inputTokens
        totals.embeddingInputTokens += inputTokens ?? 0
        return json(200, { model: result.model, dimension: result.dimension, vectors: result.vectors, metadata: { requestId, providerRequestId, usage: result.usage } }, headers)
      } catch (error) {
        if (error instanceof PayloadTooLargeError) { outcome = 'invalid_request'; return json(413, { error: { code: 'invalid_request' } }, headers) }
        if (error instanceof ContractError) { outcome = error.code; return json(400, { error: { code: error.code } }, headers) }
        if (error instanceof ProviderError) { outcome = error.code; return json(error.status, { error: { code: error.code } }, headers) }
        return json(500, { error: { code: 'server_error' } }, headers)
      } finally {
        release?.()
        if (outcome !== 'success' && outcome !== 'rate_limited') totals.failures++
        options.log?.({ requestId, sessionId: session.id, task, durationMs: Date.now() - started, outcome, providerRequestId, inputTokens })
      }
    }
    if (path === `${BASE}/ask` && request.method === 'POST') {
      totals.askRequests++
      let outcome = 'server_error'; let providerRequestId: string | undefined; let usage: GenerationResult['metadata']['usage']
      let release: (() => void) | null = null
      try {
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) return json(415, { error: { code: 'invalid_request' } }, headers)
        if (!options.ask) { outcome = 'unavailable'; return json(503, { error: { code: 'unavailable' } }, headers) }
        release = limiter.enter(session.id)
        if (!release) { outcome = 'rate_limited'; totals.rateLimits++; return json(429, { error: { code: 'rate_limited' } }, { ...headers, 'Retry-After': '60' }) }
        const input = parseAskInput(await readJson(request, limits.maxBodyBytes))
        const result = await options.ask(input, request.signal)
        if (!validAskAnswer(result.answer, input.evidence)) throw new ContractError('malformed_response')
        providerRequestId = result.metadata.providerRequestId; usage = result.metadata.usage
        outcome = 'success'; totals.successes++; totals.inputTokens += usage?.inputTokens ?? 0; totals.outputTokens += usage?.outputTokens ?? 0
        return json(200, { answer: result.answer, metadata: { requestId, model: result.metadata.model, providerRequestId, usage } }, headers)
      } catch (error) {
        if (error instanceof PayloadTooLargeError) { outcome = 'invalid_request'; return json(413, { error: { code: 'invalid_request' } }, headers) }
        if (error instanceof ContractError) { outcome = error.code; return json(error.code === 'invalid_request' ? 400 : 502, { error: { code: error.code } }, headers) }
        if (error instanceof ProviderError) { outcome = error.code; return json(error.status, { error: { code: error.code } }, headers) }
        return json(500, { error: { code: 'server_error' } }, headers)
      } finally {
        release?.()
        if (outcome !== 'success' && outcome !== 'rate_limited') totals.failures++
        options.log?.({ requestId, sessionId: session.id, task: 'ask', durationMs: Date.now() - started, outcome, providerRequestId, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens })
      }
    }
    if (path !== BASE || request.method !== 'POST') return json(405, { error: { code: 'invalid_request' } }, { ...headers, Allow: 'POST' })

    totals.requests += 1
    let task: string | undefined
    let outcome = 'server_error'
    let providerRequestId: string | undefined
    let usage: GenerationResult['metadata']['usage']
    let release: (() => void) | null = null
    try {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) return json(415, { error: { code: 'invalid_request' } }, headers)
      if (!options.generate) { outcome = 'unavailable'; return json(503, { error: { code: 'unavailable' } }, headers) }
      release = limiter.enter(session.id)
      if (!release) { outcome = 'rate_limited'; totals.rateLimits += 1; return json(429, { error: { code: 'rate_limited' } }, { ...headers, 'Retry-After': '60' }) }
      const input = parseAssistantInput(await readJson(request, limits.maxBodyBytes))
      task = input.task
      const result = await options.generate(input, request.signal)
      providerRequestId = result.metadata.providerRequestId
      usage = result.metadata.usage
      outcome = 'success'
      totals.successes += 1
      totals.inputTokens += usage?.inputTokens ?? 0
      totals.outputTokens += usage?.outputTokens ?? 0
      return json(200, { suggestions: result.suggestions, metadata: { requestId, model: result.metadata.model, providerRequestId, usage } }, headers)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) { outcome = 'invalid_request'; return json(413, { error: { code: 'invalid_request' } }, headers) }
      if (error instanceof ContractError) {
        outcome = error.code
        return json(error.code === 'invalid_request' ? 400 : 502, { error: { code: error.code } }, headers)
      }
      if (error instanceof ProviderError) {
        outcome = error.code
        return json(error.status, { error: { code: error.code } }, headers)
      }
      return json(500, { error: { code: 'server_error' } }, headers)
    } finally {
      release?.()
      if (outcome !== 'success' && outcome !== 'rate_limited') totals.failures += 1
      options.log?.({ requestId, sessionId: session.id, task, durationMs: Date.now() - started, outcome, providerRequestId, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

function embeddingStatus(options: { embed?: (texts: string[], signal: AbortSignal) => Promise<EmbeddingResult>; embeddingInfo?: { model: string; dimension: number }; mockMode?: boolean }) {
  if (!options.embed || !options.embeddingInfo) return { status: 'unavailable' }
  return { status: options.mockMode ? 'mock' : 'ready', ...options.embeddingInfo }
}

function parseEmbeddingInput(raw: unknown): { kind: 'query' | 'documents'; texts: string[] } {
  if (!isRecord(raw) || Object.keys(raw).length !== 2 || !['query', 'documents'].includes(String(raw.kind)) || !Array.isArray(raw.texts)) throw new ContractError('invalid_request')
  const kind = raw.kind as 'query' | 'documents'
  const maximum = kind === 'query' ? 1 : 2
  const textLimit = kind === 'query' ? 300 : 3500
  if (raw.texts.length < 1 || raw.texts.length > maximum || raw.texts.some(text => typeof text !== 'string' || !text.trim() || text.length > textLimit)) throw new ContractError('invalid_request')
  return { kind, texts: raw.texts as string[] }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw new PayloadTooLargeError()
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new PayloadTooLargeError()
  try { return JSON.parse(raw) } catch { throw new ContractError('invalid_request') }
}

function json(status: number, body: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } })
}
