import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageLightbox, adjacentImageIndex, lightboxActionForKey } from './ImageLightbox'
import type { Media } from './types'

const images = ['First', 'Second', 'Third'].map((title, index) => ({
  id: `image-${index + 1}`,
  mediaType: 'image',
  filename: `${title.toLowerCase()}.jpg`,
  mimeType: 'image/jpeg',
  byteSize: 1024,
  importedAt: '2026-09-20T10:00:00Z',
  title,
  caption: `${title} caption`,
  storageKey: `media/image-${index + 1}`,
  version: 1,
})) satisfies Media[]

describe('ImageLightbox', () => {
  it('opens the requested image with position and accessible controls', () => {
    const markup = renderToStaticMarkup(
      <ImageLightbox images={images} initialIndex={1} onClose={() => undefined}/>,
    )

    expect(markup).toContain('2 of 3')
    expect(markup).toContain('Second')
    expect(markup).toContain('Second caption')
    expect(markup).toContain('aria-label="Previous image"')
    expect(markup).toContain('aria-label="Next image"')
    expect(markup).toContain('aria-label="Close image viewer"')
  })

  it('navigates previous and next with wrapping', () => {
    expect(adjacentImageIndex(0, 3, 1)).toBe(1)
    expect(adjacentImageIndex(2, 3, 1)).toBe(0)
    expect(adjacentImageIndex(0, 3, -1)).toBe(2)
  })

  it('maps keyboard controls including Escape', () => {
    expect(lightboxActionForKey('ArrowLeft')).toBe('previous')
    expect(lightboxActionForKey('ArrowRight')).toBe('next')
    expect(lightboxActionForKey('Escape')).toBe('close')
    expect(lightboxActionForKey('Enter')).toBeNull()
  })
})

