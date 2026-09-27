import { describe, expect, it } from 'vitest'
import { extractPhotoMetadata, parseFilenameDate, suggestPhotoDate } from './photoMetadata'

describe('photo metadata interpretation', () => {
  it('extracts the supported EXIF abstraction without testing parser internals', async () => {
    const file = new File(['photo'], 'camera.jpg', { type: 'image/jpeg', lastModified: Date.UTC(2024, 0, 2) })
    const metadata = await extractPhotoMetadata(file, async () => ({
      DateTimeOriginal: new Date(2014, 5, 12, 8, 30, 0),
      CreateDate: '2014:06:13 09:45:00',
      latitude: 33.4484,
      longitude: -112.074,
      Make: 'Canon',
      Model: 'EOS',
      Orientation: 6,
    }))

    expect(metadata).toMatchObject({
      exifOriginalDate: '2014-06-12T08:30:00',
      exifCreateDate: '2014-06-13T09:45:00',
      latitude: 33.4484,
      longitude: -112.074,
      cameraMake: 'Canon',
      cameraModel: 'EOS',
      orientation: 6,
    })
  })

  it('keeps the camera-local calendar day when EXIF returns a Date object', async () => {
    const localCaptureTime = new Date(2014, 5, 12, 23, 45, 0)
    const file = new File(['photo'], 'camera.jpg', { type: 'image/jpeg' })
    const metadata = await extractPhotoMetadata(file, async () => ({ DateTimeOriginal: localCaptureTime }))

    expect(metadata.exifOriginalDate).toBe('2014-06-12T23:45:00')
    expect(suggestPhotoDate(file.name, metadata)).toMatchObject({ date: '2014-06-12', source: 'exif-original' })
  })

  it('uses original EXIF, embedded create, filename, then modified date precedence', () => {
    expect(suggestPhotoDate('IMG_20200101.jpg', {
      exifOriginalDate: '2014-06-12T08:30:00Z',
      exifCreateDate: '2015-01-01T00:00:00Z',
      fileModifiedDate: '2024-01-02T00:00:00Z',
    })).toMatchObject({ date: '2014-06-12', source: 'exif-original', confidence: 'high' })
    expect(suggestPhotoDate('plain.jpg', { exifCreateDate: '2015-01-01T00:00:00Z' })).toMatchObject({ date: '2015-01-01', source: 'exif-created' })
    expect(suggestPhotoDate('IMG_20140612_101500.jpg', { fileModifiedDate: '2024-01-02T00:00:00Z' })).toMatchObject({ date: '2014-06-12', source: 'filename', confidence: 'medium' })
    expect(suggestPhotoDate('plain.jpg', { fileModifiedDate: '2024-01-02T00:00:00Z' })).toMatchObject({ date: '2024-01-02', source: 'file-modified', confidence: 'low' })
    expect(suggestPhotoDate('plain.jpg', {})).toEqual({ label: 'No reliable date' })
  })

  it('recognizes conservative filename dates and rejects invalid or ambiguous numbers', () => {
    expect(parseFilenameDate('2014-06-12.jpg')).toBe('2014-06-12')
    expect(parseFilenameDate('Screenshot_2023-04-17_12-10.png')).toBe('2023-04-17')
    expect(parseFilenameDate('IMG_20140612_101500.jpg')).toBe('2014-06-12')
    expect(parseFilenameDate('IMG_20141340.jpg')).toBeUndefined()
    expect(parseFilenameDate('photo_12345678.jpg')).toBeUndefined()
  })
})
