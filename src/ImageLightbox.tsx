import { useEffect, useState } from 'react'
import { mediaAlt } from './mediaPresentation'
import type { Media } from './types'
import { useMediaUrl } from './useMediaUrl'

export type LightboxAction = 'close' | 'previous' | 'next' | null

export function lightboxActionForKey(key: string): LightboxAction {
  if (key === 'Escape') return 'close'
  if (key === 'ArrowLeft') return 'previous'
  if (key === 'ArrowRight') return 'next'
  return null
}

export function adjacentImageIndex(index: number, length: number, direction: -1 | 1) {
  if (length < 1) return 0
  return (index + direction + length) % length
}

export function ImageLightbox({ images, initialIndex, onClose }: {
  images: Media[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, images.length - 1)))
  const current = images[index]
  const preview = useMediaUrl(current, 'original', Boolean(current))
  const move = (direction: -1 | 1) => setIndex(value => adjacentImageIndex(value, images.length, direction))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = lightboxActionForKey(event.key)
      if (!action) return
      event.preventDefault()
      if (action === 'close') onClose()
      else move(action === 'previous' ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [images.length, onClose])

  if (!current) return null

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer">
      <div className="lightbox-head">
        <span>{index + 1} of {images.length}</span>
        <button autoFocus onClick={onClose} aria-label="Close image viewer">×</button>
      </div>
      <div className="lightbox-stage">
        <button
          className="lightbox-nav previous"
          onClick={() => move(-1)}
          disabled={images.length < 2}
          aria-label="Previous image"
        >
          ‹
        </button>
        {preview.url
          ? <img src={preview.url} alt={mediaAlt(current)}/>
          : <div className="lightbox-fallback">{preview.loading ? 'Loading full image…' : 'Full image unavailable'}</div>}
        <button
          className="lightbox-nav next"
          onClick={() => move(1)}
          disabled={images.length < 2}
          aria-label="Next image"
        >
          ›
        </button>
      </div>
      <div className="lightbox-caption">
        <strong>{current.title || current.filename}</strong>
        {current.caption && <p>{current.caption}</p>}
      </div>
    </div>
  )
}

