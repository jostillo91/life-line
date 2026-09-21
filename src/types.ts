export type EntryType = 'story' | 'event' | 'journal' | 'milestone' | 'memory'
export type DatePrecision = 'exact' | 'month' | 'year' | 'approximate' | 'range' | 'season' | 'age' | 'unknown'
export type Confidence = 'confirmed' | 'likely' | 'approximate' | 'guess' | 'unknown'
export interface EventDate { precision: DatePrecision; start?: string; end?: string; season?: 'Spring'|'Summer'|'Autumn'|'Winter'; age?: number; display?: string; confidence: Confidence }
export interface Entry { id:string; title:string; body:string; entryType:EntryType; eventDate:EventDate; recordTime:string; createdAt:string; updatedAt:string; importance:number; status:'active'|'archived'; peopleIds:string[]; placeIds:string[]; tagIds:string[]; mediaIds:string[]; relatedEntryIds:string[]; notes?:string }
export interface Person { id:string; name:string; nickname?:string; relationship?:string; notes?:string }
export interface Place { id:string; name:string; description?:string; latitude?:number; longitude?:number }
export interface Tag { id:string; name:string; color:string }
export interface LifeEra { id:string; name:string; start?:string; end?:string; description?:string; visualId?:string }
export type MediaType='image'|'video'|'audio'|'document'
export interface Media { id:string; mediaType:MediaType; filename:string; mimeType:string; byteSize:number; importedAt:string; title?:string; caption?:string; captureDate?:string; width?:number; height?:number; duration?:number; storageKey:string; thumbnailKey?:string; version:1 }
export interface MediaFile { key:string; blob:Blob }
export interface Archive { entries:Entry[]; people:Person[]; places:Place[]; tags:Tag[]; eras:LifeEra[]; media?:Media[] }
