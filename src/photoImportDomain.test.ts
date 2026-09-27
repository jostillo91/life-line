import { describe, expect, it } from 'vitest'
import { attachImportedMedia, eventDateForPhotos } from './photoImportDomain'
import type { Entry } from './types'

describe('photo import timeline decisions', () => {
  it('suggests exact, month, and range dates using the existing uncertain-date model', () => {
    expect(eventDateForPhotos([{ date: '2011-07-04', precision: 'exact' }])).toEqual({ precision: 'exact', start: '2011-07-04', confidence: 'likely' })
    expect(eventDateForPhotos([
      { date: '2011-07-04', precision: 'exact' },
      { date: '2011-07-18', precision: 'exact' },
    ])).toEqual({ precision: 'month', start: '2011-07-01', confidence: 'approximate' })
    expect(eventDateForPhotos([
      { date: '2011-07-04', precision: 'exact' },
      { date: '2011-08-18', precision: 'exact' },
    ])).toEqual({ precision: 'range', start: '2011-07-04', end: '2011-08-18', confidence: 'approximate' })
    expect(eventDateForPhotos([])).toEqual({ precision: 'unknown', confidence: 'unknown' })
  })

  it('attaches imported photos without changing the memory event date', () => {
    const entry = {
      id: 'memory',
      mediaIds: ['existing'],
      eventDate: { precision: 'year', start: '1998-01-01', confidence: 'confirmed' },
      updatedAt: 'old',
    } as Entry
    const attached = attachImportedMedia(entry, ['new', 'existing'], 'new-time')

    expect(attached.mediaIds).toEqual(['existing', 'new'])
    expect(attached.eventDate).toBe(entry.eventDate)
    expect(attached.updatedAt).toBe('new-time')
  })
})

