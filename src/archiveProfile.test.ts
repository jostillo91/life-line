import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { archive, db, importArchive } from './db'
import { createArchiveManifest, migrateAndValidateArchive, planArchiveMerge, prepareReplaceData } from './archiveFormat'
import { createLifeLineArchive, inspectLifeLineArchive, restoreLifeLineArchive } from './archiveService'
import { decryptLifeLineArchive, encryptLifeLineArchive } from './encryptedArchive'
import type { Archive } from './types'
const empty: Archive = { entries: [], people: [], places: [], tags: [], eras: [], media: [] }
const profile = { birthDate: '1991-06-15' }
describe('archive-owned birth date', () => {
  beforeEach(async () => { db.close(); await db.delete(); await db.open() })
  afterAll(() => db.close())
  it('validates optional metadata while accepting older archive v1 data', () => {
    const data = { ...empty, profile }
    expect(migrateAndValidateArchive(createArchiveManifest(data, []), data).data.profile).toEqual(profile)
    expect(prepareReplaceData(data).profile).toEqual(profile)
    expect(migrateAndValidateArchive(createArchiveManifest(empty, []), empty).data.profile).toBeUndefined()
    const invalid = { ...empty, profile: { birthDate: '1991-02-31' } }
    expect(() => migrateAndValidateArchive(createArchiveManifest(invalid, []), invalid)).toThrow('birth date')
  })
  it('retains a configured local birth date on Merge, adopts incoming only when absent', () => {
    expect(planArchiveMerge({ ...empty, profile }, { ...empty, profile: { birthDate: '2000-01-01' } }).data.profile).toEqual(profile)
    expect(planArchiveMerge(empty, { ...empty, profile }).data.profile).toEqual(profile)
    expect(planArchiveMerge({ ...empty, profile: {} }, { ...empty, profile }).data.profile).toEqual(profile)
  })
  it('includes profile in encrypted full backup and Replace, clearing it for older backups', async () => {
    await db.archiveSettings.put({ key: 'profile', value: profile })
    const backup = await createLifeLineArchive()
    const encrypted = await encryptLifeLineArchive(backup.blob, 'timeline synthetic test password')
    const inspected = await inspectLifeLineArchive(await decryptLifeLineArchive(encrypted, 'timeline synthetic test password'))
    expect(inspected.data.profile).toEqual(profile)
    await db.archiveSettings.put({ key: 'profile', value: { birthDate: '2000-01-01' } })
    await restoreLifeLineArchive(inspected, 'replace')
    expect((await archive()).profile).toEqual(profile)
    await importArchive(empty, 'replace')
    const legacy = await inspectLifeLineArchive((await createLifeLineArchive()).blob)
    await db.archiveSettings.put({ key: 'profile', value: profile })
    await restoreLifeLineArchive(legacy, 'replace')
    expect((await archive()).profile).toBeUndefined()
  })
  it('includes profile in JSON archives and uses the same Merge/Replace policy', async () => {
    await importArchive({ ...empty, profile }, 'merge')
    expect(JSON.parse(JSON.stringify(await archive())).profile).toEqual(profile)
    await importArchive({ ...empty, profile: { birthDate: '2000-01-01' } }, 'merge')
    expect((await archive()).profile).toEqual(profile)
    await importArchive(empty, 'replace')
    expect((await archive()).profile).toBeUndefined()
  })
  it('rejects invalid JSON profile data before replacing the local profile', async () => {
    await importArchive({ ...empty, profile }, 'merge')
    await expect(importArchive({ ...empty, profile: { birthDate: '2001-02-31' } }, 'replace')).rejects.toThrow('birth date')
    expect((await archive()).profile).toEqual(profile)
  })
  it('upgrades version 6 without rewriting existing records', async () => {
    db.close(); await db.delete()
    const old = new Dexie('life-line-diary')
    old.version(6).stores({ entries: 'id, entryType, updatedAt, *tagIds, *peopleIds, *mediaIds', people: 'id,name', places: 'id,name', tags: 'id,name', eras: 'id,name', media: 'id,mediaType,filename,importedAt,contentHash,captureDate,placeId', mediaFiles: 'key', restoreFiles: 'key', semanticVectors: 'memoryId,model,indexVersion', semanticSettings: 'key' })
    await old.open(); await old.table('people').put({ id: 'existing', name: 'Existing Person' }); old.close()
    await db.open()
    expect(db.verno).toBe(8)
    expect(await db.people.get('existing')).toEqual({ id: 'existing', name: 'Existing Person' })
    expect(await db.archiveSettings.count()).toBe(0)
  })
})
