import { useEffect, useState } from 'react'
import { createImageThumbnail, createMediaUrl, mediaPreviewUrl, revokeMediaUrl } from './mediaStorage'
import type { Media } from './types'

export type MediaUrlState = { url?: string; loading: boolean }

export function useMediaUrl(
  media: Media | undefined,
  source: 'thumbnail' | 'original',
  enabled = true,
) {
  const [preview, setPreview] = useState<MediaUrlState>({ loading: enabled && Boolean(media) })

  useEffect(() => {
    let disposed = false
    let objectUrl: string | undefined
    setPreview({ loading: enabled && Boolean(media) })
    if (!enabled || !media) return

    const load = async () => {
      if (source === 'original') return createMediaUrl(media)
      if (media.mediaType === 'image' && !media.thumbnailKey) {
        try { return mediaPreviewUrl(await createImageThumbnail(media)) }
        catch { return createMediaUrl(media) }
      }
      return mediaPreviewUrl(media)
    }
    load()
      .then(url => {
        if (disposed) {
          revokeMediaUrl(url)
          return
        }
        objectUrl = url
        setPreview({ url, loading: false })
      })
      .catch(() => {
        if (!disposed) setPreview({ loading: false })
      })

    return () => {
      disposed = true
      revokeMediaUrl(objectUrl)
    }
  }, [enabled, media?.id, media?.storageKey, media?.thumbnailKey, source])

  return preview
}
