export type EntryType = 'story' | 'event' | 'journal' | 'milestone' | 'memory'
export type DatePrecision = 'exact' | 'month' | 'year' | 'approximate' | 'range' | 'season' | 'age' | 'unknown'
export type Confidence = 'confirmed' | 'likely' | 'approximate' | 'guess' | 'unknown'
export interface EventDate { precision: DatePrecision; start?: string; end?: string; season?: 'Spring'|'Summer'|'Autumn'|'Winter'; age?: number; display?: string; confidence: Confidence }
export interface Entry { id:string; title:string; body:string; entryType:EntryType; eventDate:EventDate; recordTime:string; createdAt:string; updatedAt:string; importance:number; status:'active'|'archived'; peopleIds:string[]; placeIds:string[]; tagIds:string[]; mediaIds:string[]; relatedEntryIds:string[]; notes?:string; deletedAt?:string }
export interface Person { id:string; name:string; nickname?:string; relationship?:string; notes?:string }
export interface Place { id:string; name:string; description?:string; address?:string; latitude?:number; longitude?:number }
export interface Tag { id:string; name:string; color:string }
export interface LifeEra { id:string; name:string; start?:string; end?:string; description?:string; visualId?:string }
export type MediaType='image'|'video'|'audio'|'document'
export type MediaDateSource='exif-original'|'exif-created'|'filename'|'file-modified'|'user'
export type MediaDateConfidence='high'|'medium'|'low'
export interface PhotoMetadata { exifOriginalDate?:string; exifCreateDate?:string; fileModifiedDate?:string; latitude?:number; longitude?:number; cameraMake?:string; cameraModel?:string; orientation?:number }
export interface Media { id:string; mediaType:MediaType; filename:string; mimeType:string; byteSize:number; importedAt:string; title?:string; caption?:string; captureDate?:string; captureDateSource?:MediaDateSource; captureDateConfidence?:MediaDateConfidence; captureDatePrecision?:'exact'|'month'|'year'|'approximate'; photoMetadata?:PhotoMetadata; contentHash?:string; placeId?:string; placeSuggestionIgnored?:boolean; width?:number; height?:number; duration?:number; storageKey:string; thumbnailKey?:string; version:1|2|3 }
export interface MediaFile { key:string; blob:Blob }
export interface RestoreFile { key:string; blob:Blob }
export interface ArchiveProfile { birthDate?: string }
export type RevisionSource = 'editor' | 'dateMove' | 'restore' | 'undo' | 'relationship' | 'media' | 'assistantAccepted' | 'delete'
export interface MemoryRevision { id:string; memoryId:string; createdAt:string; source:RevisionSource; snapshot:Entry; changedFields:string[]; checkpointKey?:string }
export interface Archive { entries:Entry[]; people:Person[]; places:Place[]; tags:Tag[]; eras:LifeEra[]; media?:Media[]; profile?: ArchiveProfile; revisions?:MemoryRevision[] }
