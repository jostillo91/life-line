import type { AIProvider, AIRequest, SuggestedContent, SuggestionType } from './assistantDomain'

type Output = { type: SuggestionType; content: SuggestedContent }

const questionPrompts = [
  'Who else do you remember being there?',
  'What do you remember seeing or hearing?',
  'What happened immediately afterward?',
  'Is there a detail you are uncertain about?',
]

let failNextRequest = false
export function failNextMockRequest() { failNextRequest = true }

export const mockAIProvider: AIProvider = {
  id: 'local-mock', kind: 'local', model: 'deterministic-demo',
  async generate({ task, context, questionIndex = 0 }: AIRequest, signal: AbortSignal): Promise<Output[]> {
    if (signal.aborted) throw new Error('Request cancelled.')
    if (failNextRequest) { failNextRequest = false; throw new Error('Simulated local assistant failure.') }
    const body = `${context.memory.title} ${context.memory.body}`
    if (task === 'remember') return [{ type: 'question', content: { text: questionPrompts[questionIndex % questionPrompts.length] } }]
    if (task === 'write') {
      const original = context.memory.body.trim()
      return [{ type: 'draft', content: { text: original
        ? `${original}\n\nI may want to add what I remember feeling, who was there, and what happened next.`
        : 'I remember this moment, but I still want to add who was there, where it happened, and what stood out to me.' } }]
    }
    const matches: Output[] = []
    for (const person of context.people) if (!person.linked && body.toLocaleLowerCase().includes(person.name.toLocaleLowerCase())) matches.push({ type: 'person', content: { text: `Possible connection: ${person.name}`, targetId: person.id } })
    for (const place of context.places) if (!place.linked && body.toLocaleLowerCase().includes(place.name.toLocaleLowerCase())) matches.push({ type: 'place', content: { text: `Possible Place: ${place.name}`, targetId: place.id } })
    for (const era of context.eras) matches.push({ type: 'era', content: { text: `This memory may fall in the ${era.name} Life Era.`, targetId: era.id, reason: 'Based only on the stored date range; no relationship was added.' } })
    for (const related of context.relatedMemories) {
      matches.push({ type: 'related', content: { text: `Possibly related: ${related.title}`, targetId: related.id } })
      if (related.eventDate.start && context.memory.eventDate.start && related.eventDate.start.slice(0, 4) !== context.memory.eventDate.start.slice(0, 4)) {
        matches.push({ type: 'caution', content: { text: 'These memories may refer to a related event, but their dates differ. Review the evidence before changing either date.' } })
      }
    }
    if (task === 'connections') return matches.length ? matches : [{ type: 'question', content: { text: 'Are there People, Places, or memories you would like to link to this story?' } }]
    const words = body.toLocaleLowerCase()
    const proposedTag = words.includes('family') ? 'Family' : words.includes('school') ? 'School' : words.includes('travel') ? 'Travel' : 'Remember later'
    return [
      { type: 'tag', content: { text: proposedTag, reason: 'A possible organizing label, not a confirmed fact.' } },
      { type: 'tag', content: { text: 'Details to add', reason: 'A second optional label you can accept independently.' } },
      { type: 'importance', content: { text: 'Consider marking this as important', value: Math.min(5, Math.max(2, context.memory.body.length > 120 ? 4 : 3)) } },
      ...matches,
    ]
  },
}
