import { describe, expect, it } from 'vitest'
import { attachMedia, detachMedia, reorderMedia, mediaMatches } from './mediaDomain'
import type { Entry, Media } from './types'
const entry={mediaIds:['a','b']} as Entry
describe('attachment workflow',()=>{it('attaches without replacing the entry',()=>expect(attachMedia(entry,'c')).toMatchObject({mediaIds:['a','b','c']}));it('detaches without destroying media identity',()=>expect(detachMedia(entry,'a').mediaIds).toEqual(['b']));it('keeps attachment order',()=>expect(reorderMedia(entry,1,0).mediaIds).toEqual(['b','a']));it('searches media metadata',()=>expect(mediaMatches({filename:'summer.jpg',title:'Lake',caption:'',id:'x'} as Media,'lake')).toBe(true))})
