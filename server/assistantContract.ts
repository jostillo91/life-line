import type { AIRequestContext, AssistantTask, SuggestedContent, SuggestionType } from '../src/assistantDomain.ts'

export interface AssistantInput { task: AssistantTask; context: AIRequestContext; questionIndex: number }
export type AssistantOutput = { type: SuggestionType; content: SuggestedContent }

export class ContractError extends Error {
  readonly code: 'invalid_request' | 'malformed_response'
  constructor(code: 'invalid_request' | 'malformed_response', message = code) { super(message); this.code = code }
}

const tasks = ['remember', 'connections', 'organize', 'write'] as const
const precisions = ['unknown', 'exact', 'month', 'year', 'approximate', 'range', 'season', 'age']
const confidences = ['confirmed', 'likely', 'approximate', 'guess', 'unknown']
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysAllowed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const stringWithin = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
const optionalString = (value: unknown, max: number) => value === undefined || stringWithin(value, max)
const nullableString = (value: unknown, max: number) => value === null || stringWithin(value, max)
const isArrayOf = (value: unknown, max: number, check: (item: unknown) => boolean) => Array.isArray(value) && value.length <= max && value.every(check)

function validDate(value: unknown): boolean {
  if (!isRecord(value) || !keysAllowed(value, ['precision', 'start', 'end', 'season', 'age', 'display', 'confidence'])) return false
  return precisions.includes(String(value.precision)) && confidences.includes(String(value.confidence))
    && optionalString(value.start, 32) && optionalString(value.end, 32) && optionalString(value.display, 120)
    && (value.season === undefined || ['Spring', 'Summer', 'Autumn', 'Winter'].includes(String(value.season)))
    && (value.age === undefined || (Number.isInteger(value.age) && Number(value.age) >= 0 && Number(value.age) <= 130))
}

function validMemory(value: unknown, bodyMax: number): boolean {
  return isRecord(value) && keysAllowed(value, ['id', 'title', 'body', 'eventDate'])
    && stringWithin(value.id, 101) && stringWithin(value.title, 121) && stringWithin(value.body, bodyMax)
    && validDate(value.eventDate)
}

function validNamed(value: unknown, keys = ['id', 'name']): boolean {
  return isRecord(value) && keysAllowed(value, keys) && stringWithin(value.id, 101) && stringWithin(value.name, 121)
}

export function parseAssistantInput(raw: unknown): AssistantInput {
  if (!isRecord(raw) || !keysAllowed(raw, ['task', 'context', 'questionIndex']) || !tasks.includes(raw.task as AssistantTask)) throw new ContractError('invalid_request')
  const questionIndex = raw.questionIndex ?? 0
  if (!Number.isInteger(questionIndex) || Number(questionIndex) < 0 || Number(questionIndex) > 20) throw new ContractError('invalid_request')
  const context = raw.context
  if (!isRecord(context) || JSON.stringify(context).length > 6500 || !keysAllowed(context, ['memory', 'relatedMemories', 'people', 'places', 'tags', 'eras', 'media', 'draftAnswer', 'truncated'])) throw new ContractError('invalid_request')
  if (!validMemory(context.memory, 3201) || !isArrayOf(context.relatedMemories, 3, item => validMemory(item, 651))) throw new ContractError('invalid_request')
  if (!isArrayOf(context.people, 8, item => isRecord(item) && validNamed(item, ['id', 'name', 'linked']) && typeof item.linked === 'boolean')) throw new ContractError('invalid_request')
  if (!isArrayOf(context.places, 8, item => {
    if (!isRecord(item) || !validNamed(item, ['id', 'name', 'linked', 'coordinates']) || typeof item.linked !== 'boolean') return false
    if (item.coordinates === undefined) return true
    const coordinates = item.coordinates
    return isRecord(coordinates) && keysAllowed(coordinates, ['latitude', 'longitude']) && typeof coordinates.latitude === 'number' && typeof coordinates.longitude === 'number'
      && Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude)
      && coordinates.latitude >= -90 && coordinates.latitude <= 90 && coordinates.longitude >= -180 && coordinates.longitude <= 180
  })) throw new ContractError('invalid_request')
  if (!isArrayOf(context.tags, 8, item => validNamed(item)) || !isArrayOf(context.eras, 4, item => validNamed(item))) throw new ContractError('invalid_request')
  if (!isArrayOf(context.media, 8, item => isRecord(item) && keysAllowed(item, ['id', 'filename', 'title', 'caption', 'captureDate', 'placeName'])
    && stringWithin(item.id, 101) && stringWithin(item.filename, 121) && optionalString(item.title, 121)
    && optionalString(item.caption, 201) && optionalString(item.captureDate, 32) && optionalString(item.placeName, 121))) throw new ContractError('invalid_request')
  if (!optionalString(context.draftAnswer, 501) || typeof context.truncated !== 'boolean') throw new ContractError('invalid_request')
  const checked = context as unknown as AIRequestContext
  if (raw.task !== 'remember' && checked.media.length) throw new ContractError('invalid_request')
  if (raw.task === 'write' && (checked.people.length || checked.places.length || checked.tags.length || checked.eras.length || checked.media.length)) throw new ContractError('invalid_request')
  return { task: raw.task as AssistantTask, context: context as unknown as AIRequestContext, questionIndex: Number(questionIndex) }
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })
const field = (type: string) => ({ type })
const suggestionSchema = (kinds: string[], organization: boolean) => {
  const properties: Record<string, unknown> = {
    kind: { type: 'string', enum: kinds }, text: field('string'), targetId: nullable(field('string')), reason: nullable(field('string')),
  }
  if (organization) {
    properties.value = nullable(field('integer'))
    properties.proposedDate = nullable({ type: 'object', additionalProperties: false,
      properties: { precision: { type: 'string', enum: ['year', 'month', 'approximate', 'range', 'season', 'unknown'] }, start: nullable(field('string')), end: nullable(field('string')) },
      required: ['precision', 'start', 'end'],
    })
  }
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) }
}

export const outputFormats = {
  remember: { type: 'json_schema' as const, name: 'life_line_questions', strict: true,
    schema: { type: 'object', additionalProperties: false, properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { text: field('string') }, required: ['text'] } } }, required: ['questions'] } },
  connections: { type: 'json_schema' as const, name: 'life_line_connections', strict: true,
    schema: { type: 'object', additionalProperties: false, properties: { suggestions: { type: 'array', items: suggestionSchema(['existingMemory', 'existingPerson', 'existingPlace', 'tag', 'possibleUnknownPerson', 'possibleUnknownPlace', 'era', 'caution'], false) } }, required: ['suggestions'] } },
  organize: { type: 'json_schema' as const, name: 'life_line_organization', strict: true,
    schema: { type: 'object', additionalProperties: false, properties: { suggestions: { type: 'array', items: suggestionSchema(['tag', 'importance', 'existingMemory', 'existingPerson', 'existingPlace', 'possibleDate', 'caution'], true) } }, required: ['suggestions'] } },
  write: { type: 'json_schema' as const, name: 'life_line_writing_draft', strict: true,
    schema: { type: 'object', additionalProperties: false, properties: { draft: field('string') }, required: ['draft'] } },
}

const maxSuggestions = 8
const nonempty = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const optionalReason = (value: unknown) => nullableString(value, 250)

export function parseModelOutput(task: AssistantTask, rawText: string, context: AIRequestContext): AssistantOutput[] {
  let raw: unknown
  try { raw = JSON.parse(rawText) } catch { throw new ContractError('malformed_response') }
  if (!isRecord(raw)) throw new ContractError('malformed_response')
  if (task === 'remember') {
    if (!keysAllowed(raw, ['questions']) || !isArrayOf(raw.questions, 1, item => isRecord(item) && keysAllowed(item, ['text']) && nonempty(item.text, 280))) throw new ContractError('malformed_response')
    return (raw.questions as { text: string }[]).map(item => ({ type: 'question', content: { text: item.text.trim() } }))
  }
  if (task === 'write') {
    if (!keysAllowed(raw, ['draft']) || !nonempty(raw.draft, 2400)) throw new ContractError('malformed_response')
    return [{ type: 'draft', content: { text: (raw.draft as string).trim() } }]
  }
  if (!keysAllowed(raw, ['suggestions']) || !isArrayOf(raw.suggestions, maxSuggestions, item => isRecord(item))) throw new ContractError('malformed_response')
  return (raw.suggestions as Record<string, unknown>[]).map(item => parseSuggestion(task, item, context))
}

function parseSuggestion(task: 'connections' | 'organize', item: Record<string, unknown>, context: AIRequestContext): AssistantOutput {
  const organization = task === 'organize'
  const allowedKinds = organization
    ? ['tag', 'importance', 'existingMemory', 'existingPerson', 'existingPlace', 'possibleDate', 'caution']
    : ['existingMemory', 'existingPerson', 'existingPlace', 'tag', 'possibleUnknownPerson', 'possibleUnknownPlace', 'era', 'caution']
  const allowedKeys = organization ? ['kind', 'text', 'targetId', 'reason', 'value', 'proposedDate'] : ['kind', 'text', 'targetId', 'reason']
  if (!keysAllowed(item, allowedKeys) || !allowedKinds.includes(String(item.kind)) || !nonempty(item.text, 500) || !optionalReason(item.reason)
    || !nullableString(item.targetId, 101) || (organization && item.value !== null && !Number.isInteger(item.value))) throw new ContractError('malformed_response')
  const kind = String(item.kind)
  const targetId = typeof item.targetId === 'string' ? item.targetId : undefined
  const reason = typeof item.reason === 'string' ? item.reason.trim() : undefined
  const content = { text: String(item.text).trim(), ...(reason ? { reason } : {}) }
  if (kind === 'existingPerson' || kind === 'existingPlace' || kind === 'existingMemory' || kind === 'era') {
    const ids = kind === 'existingPerson' ? context.people.map(value => value.id)
      : kind === 'existingPlace' ? context.places.map(value => value.id)
        : kind === 'existingMemory' ? context.relatedMemories.map(value => value.id) : context.eras.map(value => value.id)
    if (!targetId || !ids.includes(targetId)) throw new ContractError('malformed_response')
    return { type: kind === 'existingPerson' ? 'person' : kind === 'existingPlace' ? 'place' : kind === 'existingMemory' ? 'related' : 'era', content: { ...content, targetId } }
  }
  if (targetId) throw new ContractError('malformed_response')
  if (kind === 'importance') {
    if (!organization || !Number.isInteger(item.value) || Number(item.value) < 1 || Number(item.value) > 5) throw new ContractError('malformed_response')
    return { type: 'importance', content: { ...content, value: Number(item.value) } }
  }
  if (kind === 'possibleDate') {
    if (!organization || !isRecord(item.proposedDate) || !keysAllowed(item.proposedDate, ['precision', 'start', 'end']) || !reason) throw new ContractError('malformed_response')
    const date = item.proposedDate
    if (!['year', 'month', 'approximate', 'range', 'season', 'unknown'].includes(String(date.precision)) || !nullableString(date.start, 32) || !nullableString(date.end, 32)) throw new ContractError('malformed_response')
    return { type: 'date', content: { ...content, proposedDate: { precision: date.precision as AIRequestContext['memory']['eventDate']['precision'], start: typeof date.start === 'string' ? date.start : undefined, end: typeof date.end === 'string' ? date.end : undefined, confidence: 'guess' } } }
  }
  if (organization && item.proposedDate !== null) throw new ContractError('malformed_response')
  if (kind === 'tag') return { type: 'tag', content }
  if (kind === 'possibleUnknownPerson' || kind === 'possibleUnknownPlace') return { type: 'question', content: { text: content.text, reason: 'Unconfirmed name; create or link manually if correct.' } }
  return { type: 'caution', content }
}
