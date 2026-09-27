export interface EmbeddingInfo { model: string; dimension: number }
import { requireOnline } from './networkState'
export interface EmbeddingBatch extends EmbeddingInfo { vectors: number[][] }
export interface EmbeddingProvider {
  readonly kind: 'local' | 'remote'
  info(): Promise<EmbeddingInfo>
  embedDocuments(texts: string[], signal: AbortSignal): Promise<EmbeddingBatch>
  embedQuery(text: string, signal: AbortSignal): Promise<EmbeddingBatch>
}

export const MOCK_EMBEDDING_INFO: EmbeddingInfo = { model: 'local-mock-embedding-v1', dimension: 64 }
const synonyms: Record<string, string> = {
  classroom: 'school', teacher: 'school', lessons: 'school', studying: 'school',
  journey: 'travel', trip: 'travel', vacation: 'travel', drove: 'travel',
  relatives: 'family', parents: 'family', siblings: 'family',
}

function mockVector(text: string): number[] {
  const vector = Array<number>(MOCK_EMBEDDING_INFO.dimension).fill(0)
  for (const raw of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const word = synonyms[raw] ?? raw
    let hash = 2166136261
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    vector[(hash >>> 0) % MOCK_EMBEDDING_INFO.dimension] += 1
  }
  const magnitude = Math.hypot(...vector)
  return magnitude ? vector.map(value => value / magnitude) : vector
}

export const mockEmbeddingProvider: EmbeddingProvider = {
  kind: 'local',
  async info() { return MOCK_EMBEDDING_INFO },
  async embedDocuments(texts, signal) { if (signal.aborted) throw new Error('Search cancelled.'); return { ...MOCK_EMBEDDING_INFO, vectors: texts.map(mockVector) } },
  async embedQuery(text, signal) { if (signal.aborted) throw new Error('Search cancelled.'); return { ...MOCK_EMBEDDING_INFO, vectors: [mockVector(text)] } },
}

export function createRemoteEmbeddingProvider(endpoint = '/api/memory-assistant', fetcher: typeof fetch = fetch): EmbeddingProvider {
  const base = endpoint.replace(/\/$/, '')
  async function request(kind: 'documents' | 'query', texts: string[], signal: AbortSignal): Promise<EmbeddingBatch> {
    requireOnline('Remote semantic search')
    let response: Response
    try {
      response = await fetcher(`${base}/embed`, { method: 'POST', credentials: 'include', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, texts }) })
    } catch { throw new Error(signal.aborted ? 'Search cancelled.' : 'Semantic search provider is unavailable.') }
    if (response.status === 401) throw new Error('Sign in to use semantic search.')
    if (response.status === 429) throw new Error('Search is rate limited. Try again shortly.')
    if (!response.ok) throw new Error('Semantic search provider is unavailable.')
    let body: unknown
    try { body = await response.json() } catch { throw new Error('Search provider returned an unusable result.') }
    if (!validBatch(body, texts.length)) throw new Error('Search provider returned an unusable result.')
    return body
  }
  return {
    kind: 'remote',
    async info() {
      requireOnline('Remote semantic search')
      let response: Response
      try { response = await fetcher(`${base}/status`, { credentials: 'include', cache: 'no-store' }) }
      catch { throw new Error('Semantic search provider is unavailable.') }
      if (response.status === 401) throw new Error('Sign in to use semantic search.')
      if (!response.ok) throw new Error('Semantic search provider is unavailable.')
      const body: unknown = await response.json()
      const embedding = body && typeof body === 'object' ? (body as { embedding?: unknown }).embedding : undefined
      if (!embedding || typeof embedding !== 'object') throw new Error('Semantic search provider is unavailable.')
      const value = embedding as Record<string, unknown>
      if (value.status !== 'ready' && value.status !== 'mock') throw new Error('Semantic search provider is unavailable.')
      if (typeof value.model !== 'string' || !Number.isInteger(value.dimension) || Number(value.dimension) < 1 || Number(value.dimension) > 1536) throw new Error('Semantic search provider is unavailable.')
      return { model: value.model, dimension: Number(value.dimension) }
    },
    embedDocuments(texts, signal) { return request('documents', texts, signal) },
    embedQuery(text, signal) { return request('query', [text], signal) },
  }
}

function validBatch(raw: unknown, count: number): raw is EmbeddingBatch {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as Record<string, unknown>
  const dimension = Number(value.dimension)
  return typeof value.model === 'string' && Number.isInteger(dimension) && dimension >= 1 && dimension <= 1536
    && Array.isArray(value.vectors) && value.vectors.length === count
    && value.vectors.every(vector => Array.isArray(vector) && vector.length === dimension && vector.every(item => typeof item === 'number' && Number.isFinite(item)))
}
