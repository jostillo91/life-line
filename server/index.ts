import { createServer } from 'node:http'
import { createAssistantAPI } from './assistantApi.ts'
import type { AssistantInput } from './assistantContract.ts'
import { readServerConfig } from './config.ts'
import { createOpenAIGateway } from './openaiGateway.ts'
import { createOpenAIEmbeddingGateway } from './embeddingGateway.ts'
import { createOpenAIAskGateway } from './askGateway.ts'
import type { AskInput } from './askContract.ts'
import { mockAskAnswer } from '../src/askProvider.ts'
import { PrivateAccess } from './privateAccess.ts'
import { mockAIProvider } from '../src/mockAIProvider.ts'
import { mockEmbeddingProvider, MOCK_EMBEDDING_INFO } from '../src/embeddingProvider.ts'

const config = readServerConfig(process.env)
const apiKey = process.env.OPENAI_API_KEY
const generate = config.mock
  ? async (input: AssistantInput, signal: AbortSignal) => ({
    suggestions: await mockAIProvider.generate({ ...input, safetyInstructions: '' }, signal),
    metadata: { model: 'deterministic-demo' },
  })
  : apiKey ? createOpenAIGateway(apiKey, config.model, undefined, config.maxOutputTokens) : undefined
const embed = config.mock
  ? async (texts: string[], signal: AbortSignal) => {
    const result = await mockEmbeddingProvider.embedDocuments(texts, signal)
    return { ...result, usage: { inputTokens: 0 } }
  }
  : apiKey ? createOpenAIEmbeddingGateway(apiKey, config.embeddingModel, config.embeddingDimension) : undefined
const ask = config.mock
  ? async (input: AskInput) => ({ answer: mockAskAnswer(input), metadata: { model: 'deterministic-demo' } })
  : apiKey ? createOpenAIAskGateway(apiKey, config.model, undefined, config.maxOutputTokens) : undefined
const handle = createAssistantAPI({
  allowedOrigin: config.allowedOrigin, access: new PrivateAccess(config.password, config.sessionTtlMinutes, config.production), generate, embed, ask,
  embeddingInfo: embed ? config.mock ? MOCK_EMBEDDING_INFO : { model: config.embeddingModel, dimension: config.embeddingDimension } : undefined,
  mockMode: config.mock, limits: config.limits,
  log: event => console.info(JSON.stringify(event)),
})

createServer(async (incoming, outgoing) => {
  const controller = new AbortController()
  incoming.on('aborted', () => controller.abort())
  outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort() })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of incoming) {
      size += chunk.length
      if (size > config.limits.maxBodyBytes) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
        outgoing.end(JSON.stringify({ error: { code: 'invalid_request' } }))
        return
      }
      chunks.push(chunk)
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value)
      else if (Array.isArray(value)) headers.set(name, value.join(', '))
    }
    const request = new Request(`http://localhost${incoming.url ?? '/'}`, {
      method: incoming.method, headers,
      body: incoming.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined,
      signal: controller.signal,
    })
    const response = await handle(request, incoming.socket.remoteAddress ?? 'unknown')
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    if (!outgoing.writableEnded) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      outgoing.end(JSON.stringify({ error: { code: 'server_error' } }))
    }
  }
}).listen(config.port, config.host, () => console.info(`Life Line AI API listening on ${config.host}:${config.port}`))
