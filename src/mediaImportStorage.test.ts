import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archive, db } from './db'
import { contentHashFor, importMediaFile, readMediaFile } from './mediaStorage'

describe('bulk photo storage', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  afterAll(() => db.close())

  it('stores identical bytes only once even when filenames differ', async () => {
    const first = new File(['same bytes'], 'first.jpg', { type: 'image/jpeg' })
    const second = new File(['same bytes'], 'renamed.jpg', { type: 'image/jpeg' })
    const initial = await importMediaFile(first)
    const duplicate = await importMediaFile(second)

    expect(initial.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.media.id).toBe(initial.media.id)
    expect(await db.media.count()).toBe(1)
    expect(await db.mediaFiles.count()).toBe(1)
    expect(duplicate.media.filename).toBe('first.jpg')
  })

  it('lazily fingerprints legacy media before accepting a duplicate', async () => {
    const legacy = {
      id: 'legacy', mediaType: 'image', filename: 'legacy.jpg', mimeType: 'image/jpeg',
      byteSize: 12, importedAt: '2020-01-01T00:00:00Z', storageKey: 'media/legacy', version: 1,
    } as const
    await db.media.put(legacy)
    await db.mediaFiles.put({ key: legacy.storageKey, blob: new Blob(['legacy bytes']) })

    const result = await importMediaFile(new File(['legacy bytes'], 'copy.jpg', { type: 'image/jpeg' }))
    expect(result).toMatchObject({ duplicate: true, media: { id: 'legacy' } })
    expect((await db.media.get('legacy'))?.contentHash).toHaveLength(64)
    expect(await db.media.count()).toBe(1)
  })

  it('keeps different files with the same filename distinct', async () => {
    const first = new File(['first bytes'], 'photo.jpg', { type: 'image/jpeg' })
    const second = new File(['second bytes'], 'photo.jpg', { type: 'image/jpeg' })
    expect(await contentHashFor(first)).not.toBe(await contentHashFor(second))

    await importMediaFile(first)
    await importMediaFile(second)
    expect(await db.media.count()).toBe(2)
    expect(await db.mediaFiles.count()).toBe(2)
  })

  it('preserves original bytes and exposes imported media through the archive', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 254, 255])
    const result = await importMediaFile(new File([bytes], 'original.jpg', { type: 'image/jpeg' }), {
      captureDate: '2014-06-12',
      captureDateSource: 'exif-original',
      captureDateConfidence: 'high',
      captureDatePrecision: 'exact',
    })
    const stored = await readMediaFile(result.media)

    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes)
    expect((await archive()).media?.map(item => item.id)).toContain(result.media.id)
    expect(result.media.captureDate).toBe('2014-06-12')
  })

  it('rolls back binary storage when metadata persistence fails', async () => {
    const put = vi.spyOn(db.media, 'put').mockRejectedValueOnce(new Error('metadata failed'))
    await expect(importMediaFile(new File(['bytes'], 'broken.jpg', { type: 'image/jpeg' }))).rejects.toThrow('metadata failed')
    put.mockRestore()

    expect(await db.media.count()).toBe(0)
    expect(await db.mediaFiles.count()).toBe(0)
  })
})
