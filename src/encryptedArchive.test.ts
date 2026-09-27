import { describe, expect, it } from 'vitest'
import { decryptLifeLineArchive, encryptLifeLineArchive, inspectBackupContainer } from './encryptedArchive'

const password = 'a memorable backup phrase'
const payload = new Blob(['PK\u0003\u0004', 'synthetic private archive'], { type: 'application/zip' })

describe('encrypted backup container', () => {
  it('roundtrips a payload and detects standard ZIP files from content', async () => {
    const encrypted = await encryptLifeLineArchive(payload, password)
    expect(await inspectBackupContainer(encrypted)).toEqual({
      kind: 'encrypted', version: 1, kdf: 'PBKDF2-HMAC-SHA-256', iterations: 600_000,
    })
    expect(await inspectBackupContainer(payload)).toEqual({ kind: 'standard' })
    expect(await (await decryptLifeLineArchive(encrypted, password)).arrayBuffer()).toEqual(await payload.arrayBuffer())
  })

  it('uses fresh salts and IVs and produces different ciphertext each time', async () => {
    const first = new Uint8Array(await (await encryptLifeLineArchive(payload, password)).arrayBuffer())
    const second = new Uint8Array(await (await encryptLifeLineArchive(payload, password)).arrayBuffer())
    expect(first.slice(14, 30)).not.toEqual(second.slice(14, 30))
    expect(first.slice(30, 42)).not.toEqual(second.slice(30, 42))
    expect(first).not.toEqual(second)
  })

  it('rejects wrong passwords and modified ciphertext without exposing details', async () => {
    const encrypted = await encryptLifeLineArchive(payload, password)
    await expect(decryptLifeLineArchive(encrypted, 'incorrect password')).rejects.toThrow('password may be incorrect or the file may be damaged')
    const changed = new Uint8Array(await encrypted.arrayBuffer())
    changed[changed.length - 1] ^= 1
    await expect(decryptLifeLineArchive(new Blob([changed]), password)).rejects.toThrow('password may be incorrect or the file may be damaged')
    changed[changed.length - 1] ^= 1
    changed[30] ^= 1 // Header metadata is authenticated too.
    await expect(decryptLifeLineArchive(new Blob([changed]), password)).rejects.toThrow('password may be incorrect or the file may be damaged')
  })

  it('does not put the password or payload in visible container metadata', async () => {
    const encrypted = new Uint8Array(await (await encryptLifeLineArchive(payload, password)).arrayBuffer())
    const visibleHeader = new TextDecoder().decode(encrypted.slice(0, 42))
    expect(visibleHeader).not.toContain(password)
    expect(visibleHeader).not.toContain('synthetic private archive')
    expect(new TextDecoder().decode(encrypted)).not.toContain(password)
    expect(new TextDecoder().decode(encrypted)).not.toContain('synthetic private archive')
  })

  it('rejects unsupported versions and invalid files before password entry', async () => {
    const encrypted = new Uint8Array(await (await encryptLifeLineArchive(payload, password)).arrayBuffer())
    encrypted[8] = 99
    await expect(inspectBackupContainer(new Blob([encrypted]))).rejects.toThrow('version 99 is not supported')
    await expect(inspectBackupContainer(new Blob(['not a backup']))).rejects.toThrow('not a supported Life Line backup')
  })

  it('requires a minimum password length without complexity rules', async () => {
    await expect(encryptLifeLineArchive(payload, 'short')).rejects.toThrow('at least 12 characters')
    await expect(encryptLifeLineArchive(payload, 'abcdefghijkl')).resolves.toBeInstanceOf(Blob)
  })
})
