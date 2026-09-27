import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MediaDetail, MediaDetailPreview, MediaLibrary, filterMedia, mediaReferenceCount } from './MediaLibrary'
import type { Entry, Media } from './types'

const image = {
  id: 'image-1',
  mediaType: 'image',
  filename: 'lake.jpg',
  mimeType: 'image/jpeg',
  byteSize: 2048,
  importedAt: '2026-09-20T10:00:00Z',
  title: 'Summer lake',
  caption: 'Blue water',
  storageKey: 'media/image-1',
  version: 1,
} satisfies Media

const audio = {
  ...image,
  id: 'audio-1',
  mediaType: 'audio',
  filename: 'song.mp3',
  mimeType: 'audio/mpeg',
  title: 'Road song',
  storageKey: 'media/audio-1',
} satisfies Media

const memory = {
  id: 'memory-1',
  title: 'A day at the lake',
  body: 'A memory.',
  entryType: 'memory',
  eventDate: { precision: 'approximate', start: '2020-06-15', confidence: 'likely' },
  recordTime: '2026-09-20T10:00:00Z',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-20T10:00:00Z',
  importance: 1,
  status: 'active',
  peopleIds: [],
  placeIds: [],
  tagIds: [],
  mediaIds: ['image-1'],
  relatedEntryIds: [],
} satisfies Entry

describe('Media Library integration', () => {
  it('renders archive media, filters, and associated-memory counts', () => {
    const markup = renderToStaticMarkup(
      <MediaLibrary
        media={[image, audio]}
        entries={[memory]}
        places={[]}
        onChanged={async () => undefined}
        onOpenMemory={() => undefined}
        onCreateMemory={() => undefined}
      />,
    )

    expect(markup).toContain('Media Library')
    expect(markup).toContain('Summer lake')
    expect(markup).toContain('1 memory')
    expect(markup).toContain('Road song')
    expect(markup).toContain('Unattached')
    expect(markup).toContain('Import Photos')
  })

  it('filters capture dates by known state and year', () => {
    const dated = { ...image, captureDate: '2014-06-12', captureDateSource: 'exif-original' as const }
    expect(filterMedia([dated, audio], [], '', 'date-known')).toEqual([dated])
    expect(filterMedia([dated, audio], [], '', 'date-unknown')).toEqual([audio])
    expect(filterMedia([dated, audio], [], '', 'all', '2014')).toEqual([dated])
  })

  it('filters media by confirmed Place, unassigned GPS, and missing GPS', () => {
    const placed = { ...image, id: 'placed', placeId: 'home', photoMetadata: { latitude: 33.4, longitude: -112.1 } }
    const unassigned = { ...image, id: 'unassigned', photoMetadata: { latitude: 33.5, longitude: -112.2 } }
    const noGps = { ...image, id: 'no-gps' }
    const media = [placed, unassigned, noGps]

    expect(filterMedia(media, [], '', 'all', 'all', 'place:home')).toEqual([placed])
    expect(filterMedia(media, [], '', 'all', 'all', 'gps-unassigned')).toEqual([unassigned])
    expect(filterMedia(media, [], '', 'all', 'all', 'no-gps')).toEqual([noGps])
  })

  it('filters real media by search, type, and attachment state', () => {
    expect(filterMedia([image, audio], [memory], 'lake', 'all')).toEqual([image])
    expect(filterMedia([image, audio], [memory], '', 'audio')).toEqual([audio])
    expect(filterMedia([image, audio], [memory], '', 'unused')).toEqual([audio])
    expect(mediaReferenceCount([memory], image.id)).toBe(1)
  })

  it('shows associated memory context and hides permanent deletion while referenced', () => {
    const markup = renderToStaticMarkup(
      <MediaDetail
        media={image}
        entries={[memory]}
        places={[]}
        onClose={() => undefined}
        onChanged={async () => undefined}
        onOpenMemory={() => undefined}
      />,
    )

    expect(markup).toContain('A day at the lake')
    expect(markup).toContain('About Jun 15, 2020')
    expect(markup).toContain('memory')
    expect(markup).not.toContain('>Permanently delete<')
  })

  it('allows deletion only when unattached and renders missing binaries safely', () => {
    const detail = renderToStaticMarkup(
      <MediaDetail
        media={image}
        entries={[]}
        places={[]}
        onClose={() => undefined}
        onChanged={async () => undefined}
        onOpenMemory={() => undefined}
      />,
    )
    const fallback = renderToStaticMarkup(
      <MediaDetailPreview media={image} preview={{ loading: false }}/>,
    )

    expect(detail).toContain('Permanently delete')
    expect(fallback).toContain('Preview unavailable')
  })
})
