import { format, parseISO } from 'date-fns'
import type { Entry, EventDate } from './types'
export function dateLabel(d:EventDate) { if(d.precision==='unknown') return 'Unsorted memory'; if(d.precision==='age') return d.age !== undefined ? `Around age ${d.age}` : 'Age unknown'; if(d.precision==='season') return `${d.season ?? 'Season'} ${d.start?.slice(0,4) ?? ''}`; if(d.precision==='range') return `${short(d.start)} – ${short(d.end)}`; if(!d.start) return 'Date unknown'; const base=d.precision==='year'||(d.precision==='approximate'&&/^\d{4}$/.test(d.start))?d.start.slice(0,4):d.precision==='month'?format(parseISO(d.start), 'MMMM yyyy'):format(parseISO(d.start),'MMM d, yyyy'); return d.precision==='approximate'?`About ${base}`:base }
function short(s?:string){return s?format(parseISO(s),'MMM yyyy'):'?'}
export function orderKey(entry:Entry){ const d=entry.eventDate; if(!d.start) return Number.MAX_SAFE_INTEGER; return Date.parse(d.start) }
export function sorted(entries:Entry[]){ return [...entries].sort((a,b)=>orderKey(a)-orderKey(b)||a.title.localeCompare(b.title)) }
export function years(entries:Entry[]){ return [...new Set(entries.map(e=>e.eventDate.start?.slice(0,4)).filter(Boolean) as string[])].sort() }
