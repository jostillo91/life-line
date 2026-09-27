import { deriveAskHints, selectAskEvidence, type AskEvidence } from './askDomain'
import type { AskProvider } from './askProvider'
import type { SemanticSearchService } from './semanticIndex'
import type { SearchFilters, SearchResult } from './semanticSearch'
import type { Archive } from './types'
import { liveMemories } from './recoveryDomain'

export class AskLifeLineService {
  constructor(readonly answerProvider: AskProvider | undefined, readonly semantic: SemanticSearchService | undefined) {}

  async retrieve(data: Archive, question: string, filters: SearchFilters, signal: AbortSignal, previousQuestion?: string): Promise<{ evidence: AskEvidence[]; warning?: string; semanticUsed: boolean }> {
    data={...data,entries:liveMemories(data.entries)}
    const contextQuestion = previousQuestion && /\b(then|there|that|it|they|them|he|she)\b/i.test(question)
      ? `${question} ${previousQuestion}`.slice(0, 300) : question
    const hints = deriveAskHints(contextQuestion, data, filters)
    let semantic: SearchResult[] = []
    let warning: string | undefined
    let semanticUsed = false
    if (this.semantic && await this.semantic.isEnabled()) {
      try {
        const info = await this.semantic.provider.info()
        const { status } = await this.semantic.plan(data, info)
        if (status.indexed > 0) { semantic = await this.semantic.search(data, hints.topic || contextQuestion, info, signal); semanticUsed = true }
        else warning = 'No current semantic index; using keyword and archive filters.'
      } catch (error) { if (signal.aborted) throw error; warning = 'Semantic retrieval is unavailable; using keyword and archive filters.' }
    }
    return { evidence: selectAskEvidence(data, contextQuestion, hints, semantic), warning, semanticUsed }
  }

  async answer(question: string, evidence: AskEvidence[], signal: AbortSignal, previousQuestion?: string) {
    if (!evidence.length) return undefined
    if (!this.answerProvider) throw new Error('AI answer service is unavailable.')
    return this.answerProvider.answer({ question, evidence, previousQuestion }, signal)
  }
}
