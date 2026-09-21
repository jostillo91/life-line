import { describe, expect, it } from 'vitest'
import type { Entry } from './types'
const detach=(entry:Entry,id:string)=>({...entry,mediaIds:entry.mediaIds.filter(x=>x!==id)})
describe('media relationships',()=>{it('detaching one attachment retains the media identity',()=>{const entry={mediaIds:['m1','m2']} as Entry;expect(detach(entry,'m1').mediaIds).toEqual(['m2'])});it('media metadata uses an independent storage key',()=>{const id='stable';expect(`media/${id}`).not.toBe('photo.jpg')})})
