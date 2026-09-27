import type { Entry, LifeEra, Tag } from './types'

export const normalizeTagName=(name:string)=>name.trim().replace(/\s+/g,' ').toLocaleLowerCase()
export const hasDuplicateTag=(tags:Tag[], name:string, exceptId?:string)=>tags.some(tag=>tag.id!==exceptId&&normalizeTagName(tag.name)===normalizeTagName(name))
export const chronologicalEras=(eras:LifeEra[])=>[...eras].sort((a,b)=>(a.start??'9999').localeCompare(b.start??'9999')||a.name.localeCompare(b.name))
export const referencesFor=(entries:Entry[], field:'peopleIds'|'placeIds'|'tagIds', id:string)=>entries.filter(entry=>entry.deletedAt === undefined && entry[field].includes(id))
export const detachReference=(entries:Entry[], field:'peopleIds'|'placeIds'|'tagIds', id:string)=>entries.map(entry=>entry[field].includes(id)?{...entry,[field]:entry[field].filter(reference=>reference!==id)}:entry)
