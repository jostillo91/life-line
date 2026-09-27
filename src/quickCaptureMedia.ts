import { createImageThumbnail, saveMediaFile } from './mediaStorage'
import type { Media } from './types'

export async function importCaptureFiles(files:File[], existingIds:string[], dependencies:{save:(file:File)=>Promise<Media>;thumbnail:(media:Media)=>Promise<Media>} = {save:saveMediaFile,thumbnail:createImageThumbnail}) {
  const ids = [...existingIds]
  const errors:string[] = []
  for (const file of files) {
    try {
      const media = await dependencies.save(file)
      ids.push(media.id)
      if (media.mediaType === 'image') {
        try { await dependencies.thumbnail(media) }
        catch {errors.push(`${file.name}: original added, but its preview could not be created.`)}
      }
    } catch {errors.push(`${file.name}: could not add this file. Your text is safe; try again or save without it.`)}
  }
  return {ids:[...new Set(ids)],errors}
}
