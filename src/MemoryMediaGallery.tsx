import { useMemo, useState } from 'react'
import { ImageLightbox } from './ImageLightbox'
import { formatBytes, mediaAlt } from './mediaPresentation'
import type { Entry, Media } from './types'
import { useMediaUrl } from './useMediaUrl'

export function orderedEntryMedia(entry: Entry, media: Media[]) {
  const byId = new Map(media.map(item => [item.id, item]))
  return entry.mediaIds.map(id => byId.get(id)).filter((item): item is Media => Boolean(item))
}

export function MemoryMediaGallery({ entry, media }: { entry: Entry; media: Media[] }) {
  const attached = useMemo(() => orderedEntryMedia(entry, media), [entry, media])
  const images = useMemo(() => attached.filter(item => item.mediaType === 'image'), [attached])
  const [openImageId, setOpenImageId] = useState<string | null>(null)
  const lightboxIndex = openImageId ? images.findIndex(item => item.id === openImageId) : -1

  if (!attached.length) return null

  return (
    <section className="story-media" aria-label="Attached media">
      <span className="eyebrow">MEDIA</span>
      <div className="story-media-grid">
        {attached.map(item => item.mediaType === 'image'
          ? <StoryImage key={item.id} media={item} onOpen={() => setOpenImageId(item.id)}/>
          : <StoryPlayableMedia key={item.id} media={item}/>)}
      </div>
      {lightboxIndex >= 0 && (
        <ImageLightbox
          images={images}
          initialIndex={lightboxIndex}
          onClose={() => setOpenImageId(null)}
        />
      )}
    </section>
  )
}

function StoryImage({ media, onOpen }: { media: Media; onOpen: () => void }) {
  const preview = useMediaUrl(media, 'thumbnail')

  return (
    <figure className="story-media-item story-image">
      <button onClick={onOpen} aria-label={`Open image: ${mediaAlt(media)}`}>
        {preview.url
          ? <img src={preview.url} alt={mediaAlt(media)} loading="lazy"/>
          : <span className="story-media-fallback">{preview.loading ? 'Loading image…' : 'Image preview unavailable'}</span>}
      </button>
      <MediaCaption media={media}/>
    </figure>
  )
}

function StoryPlayableMedia({ media }: { media: Media }) {
  const preview = useMediaUrl(media, 'original')

  return (
    <figure className={`story-media-item story-${media.mediaType}`}>
      {preview.url && media.mediaType === 'video' && (
        <video controls preload="metadata" src={preview.url}/>
      )}
      {preview.url && media.mediaType === 'audio' && (
        <audio controls preload="metadata" src={preview.url}/>
      )}
      {preview.url && media.mediaType === 'document' && (
        <a className="document-card" href={preview.url} download={media.filename}>
          <span>Document</span>
          <strong>{media.title || media.filename}</strong>
          <small>{media.mimeType || 'Unknown type'} · {formatBytes(media.byteSize)}</small>
          <i>Open or download</i>
        </a>
      )}
      {!preview.url && (
        <div className="story-media-fallback">
          {preview.loading ? `Loading ${media.mediaType}…` : `${media.mediaType} unavailable`}
        </div>
      )}
      {media.mediaType !== 'document' && (
        <MediaCaption media={media}/>
      )}
    </figure>
  )
}

function MediaCaption({ media }: { media: Media }) {
  if (!media.title && !media.caption) return null
  return (
    <figcaption>
      {media.title && <strong>{media.title}</strong>}
      {media.caption && <span>{media.caption}</span>}
    </figcaption>
  )
}
