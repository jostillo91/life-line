import { archive, db } from './db'
import type { EmbeddingInfo, EmbeddingProvider } from './embeddingProvider'
import { buildSearchDocument, rankSemanticResults, searchFingerprint, SEMANTIC_INDEX_VERSION, type SearchDocument, type SemanticVector } from './semanticSearch'
import type { Archive } from './types'
import { liveMemories } from './recoveryDomain'

export interface IndexStatus { indexed: number; pending: number; requiresRebuild: boolean; total: number }
type PendingDocument = { document: SearchDocument; fingerprint: string }

export class SemanticSearchService {
  constructor(readonly provider: EmbeddingProvider) {}

  async isEnabled() { return (await db.semanticSettings.get('enabled'))?.enabled === true }
  async setEnabled(enabled: boolean) { await db.semanticSettings.put({ key: 'enabled', enabled }) }
  async clearIndex() { await db.semanticVectors.clear() }
  async deleteMemory(memoryId: string) { await db.semanticVectors.delete(memoryId) }

  async plan(data: Archive, info: EmbeddingInfo): Promise<{ status: IndexStatus; pending: PendingDocument[] }> {
    data={...data,entries:liveMemories(data.entries)}
    const existing = await db.semanticVectors.toArray()
    const ids = new Set(data.entries.map(entry => entry.id))
    const orphans = existing.filter(vector => !ids.has(vector.memoryId)).map(vector => vector.memoryId)
    if (orphans.length) await db.semanticVectors.bulkDelete(orphans)
    const byId = new Map(existing.filter(vector => ids.has(vector.memoryId)).map(vector => [vector.memoryId, vector]))
    const pending: PendingDocument[] = []
    let indexed = 0
    for (const entry of data.entries) {
      const document = buildSearchDocument(entry, data)
      const fingerprint = await searchFingerprint(document)
      const stored = byId.get(entry.id)
      if (stored && compatible(stored, info) && stored.fingerprint === fingerprint) indexed++
      else pending.push({ document, fingerprint })
    }
    return { status: { indexed, pending: pending.length, total: data.entries.length,
      requiresRebuild: existing.some(vector => ids.has(vector.memoryId) && !compatible(vector, info)) }, pending }
  }

  async indexPending(data: Archive, info: EmbeddingInfo, signal: AbortSignal, onProgress?: (done: number, total: number, failures: number) => void): Promise<{ indexed: number; failures: number }> {
    const { pending } = await this.plan(data, info)
    let done = 0; let indexed = 0; let failures = 0
    for (let offset = 0; offset < pending.length; offset += 2) {
      if (signal.aborted) throw new Error('Indexing cancelled.')
      const batch = pending.slice(offset, offset + 2)
      try {
        const generated = await this.provider.embedDocuments(batch.map(item => item.document.text), signal)
        if (generated.model !== info.model || generated.dimension !== info.dimension || generated.vectors.length !== batch.length) throw new Error('Embedding model changed; rebuild the index.')
        const current = await archive()
        for (let index = 0; index < batch.length; index++) {
          const item = batch[index]
          const entry = current.entries.find(value => value.id === item.document.memoryId)
          if (!entry || await searchFingerprint(buildSearchDocument(entry, current)) !== item.fingerprint) { failures++; continue }
          const vector = generated.vectors[index]
          if (vector.length !== info.dimension || vector.some(value => !Number.isFinite(value))) { failures++; continue }
          const stored=await db.transaction('rw',[db.entries,db.semanticVectors],async () => {
            const latest=await db.entries.get(entry.id)
            if(!latest || latest.deletedAt !== undefined || buildSearchDocument(latest,current).text !== item.document.text) return false
            await db.semanticVectors.put({ memoryId: entry.id, sourceType: 'memory', model: info.model, dimension: info.dimension,
              indexVersion: SEMANTIC_INDEX_VERSION, fingerprint: item.fingerprint, generatedAt: new Date().toISOString(), vector })
            return true
          })
          if(stored) indexed++;else failures++
        }
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof Error && (error.message.includes('rate limited') || error.message.includes('Sign in') || error.message.includes('unavailable'))) {
          failures += pending.length - offset
          done = pending.length
          onProgress?.(done, pending.length, failures)
          break
        }
        failures += batch.length
      }
      done += batch.length
      onProgress?.(done, pending.length, failures)
    }
    return { indexed, failures }
  }

  async currentVectors(data: Archive, info: EmbeddingInfo): Promise<SemanticVector[]> {
    const { pending } = await this.plan(data, info)
    const stale = new Set(pending.map(item => item.document.memoryId))
    return (await db.semanticVectors.toArray()).filter(vector => !stale.has(vector.memoryId) && compatible(vector, info))
  }

  async search(data: Archive, query: string, info: EmbeddingInfo, signal: AbortSignal) {
    const batch = await this.provider.embedQuery(query, signal)
    if (batch.model !== info.model || batch.dimension !== info.dimension) throw new Error('Embedding model changed. Rebuild the semantic index.')
    return rankSemanticResults(data, query, batch.vectors[0], await this.currentVectors(data, info))
  }
}

function compatible(vector: SemanticVector, info: EmbeddingInfo) {
  return vector.model === info.model && vector.dimension === info.dimension && vector.indexVersion === SEMANTIC_INDEX_VERSION
    && vector.vector.length === info.dimension && vector.vector.every(value => Number.isFinite(value))
}
