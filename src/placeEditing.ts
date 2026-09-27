import { validCoordinates } from './locationDomain'
import type { Place } from './types'

export function preparePlaceForSave(original: Place, draft: Place): Place {
  if (draft.id !== original.id) throw new Error('Place identity cannot change while editing.')
  if (!draft.name.trim()) throw new Error('Give this Place a name.')
  if ((draft.latitude !== undefined || draft.longitude !== undefined)
    && !validCoordinates({ latitude: draft.latitude, longitude: draft.longitude })) {
    throw new Error('Enter both a valid latitude and longitude, or leave both blank.')
  }
  return { ...draft, name: draft.name.trim(), address: draft.address?.trim() || undefined }
}
