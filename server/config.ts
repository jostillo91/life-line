import { DEFAULT_LIMITS, type ApiLimits } from './assistantApi.ts'

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return parsed
}

export function readServerConfig(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === 'production'
  const host = env.LIFE_LINE_AI_HOST || '127.0.0.1'
  const port = boundedInteger(env.LIFE_LINE_AI_PORT, 8787, 1, 65535, 'LIFE_LINE_AI_PORT')
  const allowedOrigin = env.LIFE_LINE_AI_ALLOWED_ORIGIN || (production ? '' : 'http://127.0.0.1:5173')
  let origin: URL
  try { origin = new URL(allowedOrigin) } catch { throw new Error('LIFE_LINE_AI_ALLOWED_ORIGIN must be an exact origin') }
  if (allowedOrigin !== origin.origin || !['http:', 'https:'].includes(origin.protocol)) throw new Error('LIFE_LINE_AI_ALLOWED_ORIGIN must be an exact origin')
  if (production && origin.protocol !== 'https:') throw new Error('Production frontend origin must use HTTPS')
  if (!production && (!['127.0.0.1', 'localhost'].includes(host) || !['127.0.0.1', 'localhost'].includes(origin.hostname))) {
    throw new Error('Non-local deployment requires NODE_ENV=production')
  }
  if (env.LIFE_LINE_AI_PROVIDER === 'mock' && production) throw new Error('Server mock provider is development-only')
  if (env.LIFE_LINE_AI_PROVIDER && !['mock', 'openai'].includes(env.LIFE_LINE_AI_PROVIDER)) throw new Error('Unsupported AI provider')
  const model = env.OPENAI_MODEL || 'gpt-5.6-terra'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) throw new Error('Invalid OPENAI_MODEL')
  const embeddingModel = env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
  if (!['text-embedding-3-small', 'text-embedding-3-large'].includes(embeddingModel)) throw new Error('Unsupported OPENAI_EMBEDDING_MODEL')
  const embeddingDimension = boundedInteger(env.OPENAI_EMBEDDING_DIMENSIONS, 256, 1, 1536, 'OPENAI_EMBEDDING_DIMENSIONS')
  const password = env.LIFE_LINE_AI_ACCESS_PASSWORD || ''
  if (password.length < 16 || password.length > 256 || password.startsWith('replace-with-')) throw new Error('LIFE_LINE_AI_ACCESS_PASSWORD must be a unique 16–256 character secret')
  const limits: ApiLimits = {
    maxBodyBytes: boundedInteger(env.LIFE_LINE_AI_MAX_BODY_BYTES, DEFAULT_LIMITS.maxBodyBytes, 1000, 10_000, 'LIFE_LINE_AI_MAX_BODY_BYTES'),
    perSessionPerMinute: boundedInteger(env.LIFE_LINE_AI_MAX_REQUESTS_PER_MINUTE, DEFAULT_LIMITS.perSessionPerMinute, 1, 60, 'LIFE_LINE_AI_MAX_REQUESTS_PER_MINUTE'),
    globalPerMinute: boundedInteger(env.LIFE_LINE_AI_GLOBAL_REQUESTS_PER_MINUTE, DEFAULT_LIMITS.globalPerMinute, 1, 600, 'LIFE_LINE_AI_GLOBAL_REQUESTS_PER_MINUTE'),
    maxConcurrent: boundedInteger(env.LIFE_LINE_AI_MAX_CONCURRENT, DEFAULT_LIMITS.maxConcurrent, 1, 8, 'LIFE_LINE_AI_MAX_CONCURRENT'),
  }
  return {
    production, host, port, allowedOrigin, password, model, embeddingModel, embeddingDimension, limits,
    sessionTtlMinutes: boundedInteger(env.LIFE_LINE_AI_SESSION_TTL_MINUTES, 480, 5, 1440, 'LIFE_LINE_AI_SESSION_TTL_MINUTES'),
    maxOutputTokens: boundedInteger(env.LIFE_LINE_AI_MAX_OUTPUT_TOKENS, 1100, 200, 1100, 'LIFE_LINE_AI_MAX_OUTPUT_TOKENS'),
    mock: env.LIFE_LINE_AI_PROVIDER === 'mock',
  }
}
