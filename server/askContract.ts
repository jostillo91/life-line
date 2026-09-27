import { validAskAnswer, type AskAnswer, type AskEvidence } from '../src/askDomain.ts'
import { ContractError } from './assistantContract.ts'

export interface AskInput { question: string; evidence: AskEvidence[]; previousQuestion?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const short = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
const names = (value: unknown) => Array.isArray(value) && value.length <= 8 && value.every(item => short(item, 120))

export function parseAskInput(raw: unknown): AskInput {
  if (!record(raw) || !only(raw, ['question', 'evidence', 'previousQuestion']) || !short(raw.question, 300) || !(raw.question as string).trim()
    || (raw.previousQuestion !== undefined && !short(raw.previousQuestion, 300)) || !Array.isArray(raw.evidence) || raw.evidence.length < 1 || raw.evidence.length > 5) throw new ContractError('invalid_request')
  const ids = new Set<string>()
  for (const item of raw.evidence) {
    if (!record(item) || !only(item, ['memoryId', 'title', 'body', 'date', 'eventDate', 'people', 'places', 'tags', 'entryType'])
      || !short(item.memoryId, 100) || !(item.memoryId as string).trim() || !short(item.title, 120) || !short(item.body, 850)
      || !short(item.date, 120) || !names(item.people) || !names(item.places) || !names(item.tags)
      || !['memory', 'story', 'event', 'journal', 'milestone'].includes(String(item.entryType)) || !record(item.eventDate)
      || !only(item.eventDate, ['precision', 'start', 'end', 'season', 'age', 'display', 'confidence'])
      || !['exact', 'month', 'year', 'approximate', 'range', 'season', 'age', 'unknown'].includes(String(item.eventDate.precision))
      || !['confirmed', 'likely', 'approximate', 'guess', 'unknown'].includes(String(item.eventDate.confidence))
      || (item.eventDate.start !== undefined && !short(item.eventDate.start, 32)) || (item.eventDate.end !== undefined && !short(item.eventDate.end, 32))
      || (item.eventDate.display !== undefined && !short(item.eventDate.display, 120))
      || (item.eventDate.season !== undefined && !['Spring', 'Summer', 'Autumn', 'Winter'].includes(String(item.eventDate.season)))
      || (item.eventDate.age !== undefined && (!Number.isInteger(item.eventDate.age) || Number(item.eventDate.age) < 0 || Number(item.eventDate.age) > 130))
      || ids.has(item.memoryId as string)) throw new ContractError('invalid_request')
    ids.add(item.memoryId as string)
  }
  return raw as unknown as AskInput
}

const string = { type: 'string' }
export const askOutputFormat = { type: 'json_schema' as const, name: 'life_line_grounded_answer', strict: true,
  schema: { type: 'object', additionalProperties: false, properties: {
    sufficiency: { type: 'string', enum: ['sufficient', 'partial', 'insufficient'] },
    claims: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      statement: string, sourceMemoryIds: { type: 'array', items: string },
    }, required: ['statement', 'sourceMemoryIds'] } },
    sourceMemoryIds: { type: 'array', items: string },
    unresolvedQuestions: { type: 'array', items: string },
  }, required: ['sufficiency', 'claims', 'sourceMemoryIds', 'unresolvedQuestions'] } }

export function parseAskOutput(text: string, evidence: AskEvidence[]): AskAnswer {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new ContractError('malformed_response') }
  if (!validAskAnswer(value, evidence)) throw new ContractError('malformed_response')
  return value
}
