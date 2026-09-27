import type { AIProvider, AIRequest, SuggestedContent, SuggestionType } from './assistantDomain'
import { requireOnline } from './networkState'

type ResponseSuggestion = { type: SuggestionType; content: SuggestedContent }
export interface AIUsage { inputTokens: number; outputTokens: number }
export interface RemoteAIDiagnostics { requestId: string; providerRequestId?: string; model?: string; usage?: AIUsage }
export class RemoteAIError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

const messages: Record<string, string> = {
  authentication_required: 'Sign in to use the live assistant. Your memory was not changed.',
  unavailable: 'Remote AI is not configured. Your memories remain available.',
  authentication: 'AI provider authentication failed. Check the server configuration.',
  rate_limited: 'The assistant is rate limited. Please try again shortly.',
  timeout: 'The assistant took too long. Please retry.',
  malformed_response: 'The assistant returned an unusable result. Please retry.',
  invalid_request: 'The selected context could not be sent. Try reducing it.',
  server_error: 'The assistant is temporarily unavailable. Please retry.',
}

export function createRemoteAIProvider(
  endpoint = '/api/memory-assistant',
  fetcher: typeof fetch = fetch,
  onDiagnostics?: (diagnostics: RemoteAIDiagnostics) => void,
): AIProvider {
  const provider = {
    id: 'life-line-server', kind: 'remote' as const, model: undefined as string | undefined,
    async generate(request: AIRequest, signal: AbortSignal): Promise<ResponseSuggestion[]> {
      requireOnline('Remote Memory Assistant')
      const requestId = crypto.randomUUID()
      let response: Response
      try {
        response = await fetcher(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Life-Line-Request-Id': requestId },
          body: JSON.stringify({ task: request.task, context: request.context, questionIndex: request.questionIndex ?? 0 }),
          signal, credentials: 'include', cache: 'no-store',
        })
      } catch (error) {
        if (signal.aborted) throw new Error('Request cancelled.')
        throw new Error(error instanceof Error && error.name === 'AbortError' ? 'Request cancelled.' : 'Network unavailable. Your memory was not changed.')
      }
      let payload: unknown
      try { payload = await response.json() } catch { throw new Error('The assistant returned an unusable result. Please retry.') }
      const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (!response.ok) {
        const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
        const code = typeof error.code === 'string' ? error.code : 'server_error'
        throw new RemoteAIError(code, messages[code] ?? messages.server_error)
      }
      if (!Array.isArray(body.suggestions) || !body.suggestions.every(isSuggestion)) throw new Error(messages.malformed_response)
      const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : {}
      const usage = metadata.usage && typeof metadata.usage === 'object' ? metadata.usage as Record<string, unknown> : {}
      provider.model = typeof metadata.model === 'string' ? metadata.model : undefined
      onDiagnostics?.({
        requestId: typeof metadata.requestId === 'string' ? metadata.requestId : requestId,
        providerRequestId: typeof metadata.providerRequestId === 'string' ? metadata.providerRequestId : undefined,
        model: typeof metadata.model === 'string' ? metadata.model : undefined,
        usage: typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined,
      })
      return body.suggestions
    },
  }
  return provider
}

function isSuggestion(value: unknown): value is ResponseSuggestion {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (!['question', 'tag', 'person', 'place', 'era', 'related', 'importance', 'date', 'draft', 'caution'].includes(String(item.type))) return false
  if (!item.content || typeof item.content !== 'object') return false
  const content = item.content as Record<string, unknown>
  return typeof content.text === 'string' && content.text.length > 0 && content.text.length <= 2500
}
