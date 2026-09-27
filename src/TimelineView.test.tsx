import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TimelineView } from './TimelineView'
import type { Entry, Media } from './types'

const entry = {
  id: 'memory',
  title: 'Media memory',
  body: 'Story with attachments',
  entryType: 'memory',
  eventDate: { precision: 'year', start: '2020-01-01', confidence: 'confirmed' },
  recordTime: '2026-09-20T10:00:00Z',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-20T10:00:00Z',
  importance: 1,
  status: 'active',
  peopleIds: [],
  placeIds: [],
  tagIds: [],
  mediaIds: ['image', 'video', 'audio', 'document'],
  relatedEntryIds: [],
} satisfies Entry

const media: Media[] = [
  mediaItem('image', 'image', 'First photo'),
  mediaItem('video', 'video', 'Video'),
  mediaItem('audio', 'audio', 'Audio'),
  mediaItem('document', 'document', 'Document'),
]

describe('TimelineView media presentation', () => {
  it('provides accessible zoom/overview controls and disables coarse date dragging', () => {
    const markup = renderToStaticMarkup(<TimelineView entries={[entry]} eras={[]} tags={[]} media={[]} dragging={null} onDragMemory={() => undefined} onOpenMemory={() => undefined} onMoveDate={() => undefined}/> )
    expect(markup).toContain('Timeline scale'); expect(markup).toContain('Navigate timeline overview')
    expect(markup).toContain('Open memory: Media memory'); expect(markup).toContain('draggable="false"')
    expect(markup).not.toContain('Move Media memory')
  })
  it('enables explicit date review and dragging only at detailed scales', () => {
    const markup = renderTimeline(media)
    expect(markup).toContain('draggable="true"'); expect(markup).toContain('Move Media memory')
    expect(markup).toContain('year · confirmed')
  })
  it('uses the first ordered image and shows compact media indicators', () => {
    const markup = renderTimeline(media)
    expect(markup).toContain('Thumbnail: First photo')
    expect(markup).toContain('4 attached')
    expect(markup).toContain('Photo 1')
    expect(markup).toContain('Video 1')
    expect(markup).toContain('Audio 1')
    expect(markup).toContain('Document 1')
  })

  it('does not crash when an image thumbnail is missing', () => {
    expect(() => renderTimeline([{ ...media[0], thumbnailKey: undefined }])).not.toThrow()
    expect(renderTimeline([{ ...media[0], thumbnailKey: undefined }])).toContain('Loading image')
  })
})

function renderTimeline(items: Media[]) {
  return renderToStaticMarkup(
    <TimelineView
      entries={[entry]}
      initialPosition={{ zoom: 'Months', focus: Date.parse('2020-06-15') }}
      eras={[]}
      tags={[]}
      media={items}
      dragging={null}
      onDragMemory={() => undefined}
      onOpenMemory={() => undefined}
      onMoveDate={() => undefined}
    />,
  )
}

function mediaItem(id: string, mediaType: Media['mediaType'], title: string): Media {
  return {
    id,
    mediaType,
    filename: `${id}.bin`,
    mimeType: 'application/octet-stream',
    byteSize: 1024,
    importedAt: '2026-09-20T10:00:00Z',
    title,
    storageKey: `media/${id}`,
    version: 1,
  }
}
