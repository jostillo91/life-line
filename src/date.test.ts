import { describe, expect, it } from 'vitest'
import { dateLabel, sorted } from './date'
import type { Entry } from './types'
const e=(id:string,start?:string):Entry=>({id,title:id,body:'',entryType:'memory',eventDate:start?{precision:'year',start,confidence:'confirmed'}:{precision:'unknown',confidence:'unknown'},recordTime:'',createdAt:'',updatedAt:'',importance:1,status:'active',peopleIds:[],placeIds:[],tagIds:[],mediaIds:[],relatedEntryIds:[]})

it('labels age zero without treating it as missing information', () => {
  expect(dateLabel({ precision: 'age', age: 0, confidence: 'approximate' })).toBe('Around age 0')
  expect(dateLabel({ precision: 'age', confidence: 'unknown' })).toBe('Age unknown')
})
describe('uncertain dates',()=>{it('keeps undated entries after dated entries',()=>expect(sorted([e('unknown'),e('2000','2000-01-01')]).map(x=>x.id)).toEqual(['2000','unknown']));it('labels seasons and ranges',()=>{expect(dateLabel({precision:'season',start:'2014-06-01',season:'Summer',confidence:'likely'})).toBe('Summer 2014');expect(dateLabel({precision:'range',start:'2003-01-01',end:'2005-01-01',confidence:'approximate'})).toBe('Jan 2003 – Jan 2005')})})
