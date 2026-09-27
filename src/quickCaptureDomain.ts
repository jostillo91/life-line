import type { Entry, EventDate } from './types'

export const QUICK_CAPTURE_SHORTCUT = 'Ctrl/Cmd + Shift + M'
export const captureDraftKey = (archiveName:string) => `life-line:quick-capture-draft:${archiveName}`
export type CaptureDraftStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'>

export function newCaptureDraft(now = new Date(), id:string = crypto.randomUUID()):Entry {
  const timestamp = now.toISOString()
  return {id,title:'',body:'',entryType:'memory',eventDate:{precision:'unknown',confidence:'unknown'},recordTime:timestamp,createdAt:timestamp,updatedAt:timestamp,importance:1,status:'active',peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[]}
}
export function hasCaptureContent(entry:Entry) { return Boolean(entry.body.trim() || entry.title.trim() || entry.mediaIds.length) }
export function hasCaptureDraft(entry:Entry) { return hasCaptureContent(entry) || entry.eventDate.precision !== 'unknown' }

function validDraft(entry:Entry) {
  return entry && typeof entry.id === 'string' && Boolean(entry.id) && typeof entry.title === 'string' && typeof entry.body === 'string'
    && entry.entryType === 'memory' && entry.status === 'active' && Number.isFinite(entry.importance)
    && ['createdAt','recordTime','updatedAt'].every(key => typeof entry[key as keyof Entry] === 'string' && Number.isFinite(Date.parse(entry[key as keyof Entry] as string)))
    && ['peopleIds','placeIds','tagIds','mediaIds','relatedEntryIds'].every(key => Array.isArray(entry[key as keyof Entry]) && (entry[key as keyof Entry] as unknown[]).every(id => typeof id === 'string'))
    && entry.eventDate && ['unknown','exact','year','approximate','age'].includes(entry.eventDate.precision)
    && ['confirmed','likely','approximate','guess','unknown'].includes(entry.eventDate.confidence)
    && (entry.eventDate.start === undefined || typeof entry.eventDate.start === 'string')
    && (entry.eventDate.age === undefined || Number.isFinite(entry.eventDate.age))
}
export function readCaptureDraft(key:string, storage?:CaptureDraftStorage):Entry|null {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(key) ?? 'null')
    return value?.version === 1 && validDraft(value.entry) && hasCaptureDraft(value.entry) ? value.entry as Entry : null
  } catch { return null }
}
export function writeCaptureDraft(key:string, entry:Entry, storage:CaptureDraftStorage = localStorage) {
  if (hasCaptureDraft(entry)) storage.setItem(key,JSON.stringify({version:1,entry}))
  else storage.removeItem(key)
}
export function discardCaptureDraft(key:string, storage:CaptureDraftStorage = localStorage) { storage.removeItem(key) }

const calendarDay = (date:Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
export function fastCaptureDate(choice:'unknown'|'today'|'yesterday'|'year'|'approximate'|'age', now = new Date()):EventDate {
  if (choice === 'unknown') return {precision:'unknown',confidence:'unknown'}
  if (choice === 'approximate') return {precision:'approximate',confidence:'approximate'}
  if (choice === 'age') return {precision:'age',confidence:'approximate'}
  if (choice === 'year') return {precision:'year',start:`${now.getFullYear()}-01-01`,confidence:'confirmed'}
  const day = choice === 'yesterday' ? new Date(now.getFullYear(),now.getMonth(),now.getDate()-1) : now
  return {precision:'exact',start:calendarDay(day),confidence:'confirmed'}
}
export function captureDateError(date:EventDate) {
  if (date.precision === 'approximate' && (!date.start || !/^\d{4}$/.test(date.start) || Number(date.start) < 1000)) return 'Enter an approximate year (1000–9999), or choose Unknown.'
  if (date.precision === 'age' && (date.age === undefined || !Number.isFinite(date.age) || date.age < 0)) return 'Enter an approximate age, or choose Unknown.'
  return undefined
}
export function capturedMemory(draft:Entry):Entry {
  if (!hasCaptureContent(draft)) throw new Error('Write a thought, add a title, or attach a file before saving.')
  const error = captureDateError(draft.eventDate)
  if (error) throw new Error(error)
  return {...structuredClone(draft),title:draft.title.trim() || 'Untitled memory'}
}

export interface CaptureShortcutEvent { key:string; ctrlKey:boolean; metaKey:boolean; shiftKey:boolean; altKey:boolean; repeat?:boolean }
export function shouldOpenCapture(event:CaptureShortcutEvent, context:{editable:boolean;modalOpen:boolean}) {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'm' && !event.repeat && !context.editable && !context.modalOpen
}
// One submission per mounted capture. Concurrent/late clicks share the same
// result; a failed save unlocks for retry with the same canonical memory ID.
export function captureSubmission<Result>(save:(entry:Entry)=>Promise<Result>) {
  let pending:Promise<Result>|undefined
  return (draft:Entry) => {
    if (!pending) {
      pending = Promise.resolve().then(() => save(capturedMemory(draft))).catch(error => {pending=undefined;throw error})
    }
    return pending
  }
}
