import type { Entry, EventDate } from './types'

export function moveEventDate(entry:Entry, patch:Partial<EventDate>):Entry {
  return {...entry,eventDate:{...entry.eventDate,...patch}}
}

export function restoreEventDate(entry:Entry, eventDate:EventDate):Entry {
  return {...entry,eventDate:{...eventDate}}
}
