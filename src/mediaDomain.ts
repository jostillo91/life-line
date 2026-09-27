import type { Entry, Media } from './types'
export const attachMedia=(entry:Entry,id:string)=>({...entry,mediaIds:[...new Set([...entry.mediaIds,id])]})
export const detachMedia=(entry:Entry,id:string)=>({...entry,mediaIds:entry.mediaIds.filter(mediaId=>mediaId!==id)})
export const reorderMedia=(entry:Entry,from:number,to:number)=>{const mediaIds=[...entry.mediaIds];const [item]=mediaIds.splice(from,1);mediaIds.splice(to,0,item);return {...entry,mediaIds}}
export const mediaMatches=(media:Media,q:string)=>`${media.filename} ${media.title??''} ${media.caption??''} ${media.captureDate??''} ${media.photoMetadata?.cameraMake??''} ${media.photoMetadata?.cameraModel??''}`.toLowerCase().includes(q.toLowerCase())
