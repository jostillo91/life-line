import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryMediaGallery, orderedEntryMedia } from './MemoryMediaGallery'
import type { Entry, Media } from './types'

const media = [
  mediaItem('first', 'image', 'First image'),
  mediaItem('second', 'image', 'Second image'),
  mediaItem('video', 'video', 'Family video'),
]

const entry = {
  id: 'memory',
  title: 'Memory',
  body: 'Story',
  entryType: 'memory',
  eventDate: { precision: 'unknown', confidence: 'unknown' },
  recordTime: '2026-09-20T10:00:00Z',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-20T10:00:00Z',
  importance: 1,
  status: 'active',
  peopleIds: [],
  placeIds: [],
  tagIds: [],
  mediaIds: ['second', 'video', 'first'],
  relatedEntryIds: [],
} satisfies Entry

describe('MemoryMediaGallery', () => {
  it('preserves attachment ordering', () => {
    expect(orderedEntryMedia(entry, media).map(item => item.id)).toEqual(['second', 'video', 'first'])

    const markup = renderToStaticMarkup(<MemoryMediaGallery entry={entry} media={media}/>)
    expect(markup.indexOf('Second image')).toBeLessThan(markup.indexOf('Family video'))
    expect(markup.indexOf('Family video')).toBeLessThan(markup.indexOf('First image'))
  })

  it('renders images as accessible lightbox triggers', () => {
    const markup = renderToStaticMarkup(<MemoryMediaGallery entry={entry} media={media}/>)
    expect(markup).toContain('Open image: Second image')
    expect(markup).toContain('Open image: First image')
  })
})

function mediaItem(id: string, mediaType: Media['mediaType'], title: string): Media {
  return {
    id,
    mediaType,
    filename: `${id}.${mediaType === 'video' ? 'mp4' : 'jpg'}`,
    mimeType: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
    byteSize: 1024,
    importedAt: '2026-09-20T10:00:00Z',
    title,
    storageKey: `media/${id}`,
    version: 1,
  }
}

