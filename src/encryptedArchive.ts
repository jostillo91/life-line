import { ArchiveCancelledError } from './archiveCancellation'
import type { ArchiveProgress } from './archiveService'

const MAGIC = new TextEncoder().encode('LLBACKUP')
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
const CONTAINER_VERSION = 1
const KDF_PBKDF2_SHA256 = 1
const ITERATIONS = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12
const HEADER_BYTES = MAGIC.length + 1 + 1 + 4 + SALT_BYTES + IV_BYTES
const TAG_BYTES = 16
export const MIN_BACKUP_PASSWORD_LENGTH = 12

export type BackupContainer = { kind: 'standard' } | {
  kind: 'encrypted'
  version: number
  kdf: 'PBKDF2-HMAC-SHA-256'
  iterations: number
}

type EncryptedHeader = Extract<BackupContainer, { kind: 'encrypted' }> & {
  bytes: Uint8Array
  salt: Uint8Array
  iv: Uint8Array
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ArchiveCancelledError()
}

function matches(bytes: Uint8Array, prefix: Uint8Array) {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function readEncryptedHeader(bytes: Uint8Array, size: number): EncryptedHeader {
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error('Encrypted backup is incomplete or damaged.')
  const version = bytes[MAGIC.length]
  if (version !== CONTAINER_VERSION) throw new Error(`Encrypted backup version ${version} is not supported by this version of Life Line.`)
  if (bytes[MAGIC.length + 1] !== KDF_PBKDF2_SHA256) throw new Error('Encrypted backup key derivation is not supported.')
  const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length + 2)
  if (iterations < ITERATIONS || iterations > 2_000_000) throw new Error('Encrypted backup key derivation parameters are not supported.')
  const saltStart = MAGIC.length + 6
  return {
    kind: 'encrypted', version, kdf: 'PBKDF2-HMAC-SHA-256', iterations,
    bytes, salt: bytes.subarray(saltStart, saltStart + SALT_BYTES),
    iv: bytes.subarray(saltStart + SALT_BYTES, HEADER_BYTES),
  }
}

export async function inspectBackupContainer(file: Blob): Promise<BackupContainer> {
  const prefix = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())
  if (matches(prefix, MAGIC)) {
    const { version, kdf, iterations } = readEncryptedHeader(prefix, file.size)
    return { kind: 'encrypted', version, kdf, iterations }
  }
  if (matches(prefix, ZIP_MAGIC)) return { kind: 'standard' }
  throw new Error('This is not a supported Life Line backup file.')
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number, usage: KeyUsage) {
  const passwordBytes = new TextEncoder().encode(password)
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
      { name: 'AES-GCM', length: 256 }, false, [usage],
    )
  } finally {
    passwordBytes.fill(0)
  }
}

export async function encryptLifeLineArchive(
  archive: Blob, password: string,
  onProgress?: (progress: ArchiveProgress) => void, signal?: AbortSignal,
): Promise<Blob> {
  if (password.length < MIN_BACKUP_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_BACKUP_PASSWORD_LENGTH} characters.`)
  checkCancelled(signal)
  onProgress?.({ stage: 'encrypting', message: 'Encrypting backup' })
  const header = new Uint8Array(HEADER_BYTES)
  header.set(MAGIC)
  header[MAGIC.length] = CONTAINER_VERSION
  header[MAGIC.length + 1] = KDF_PBKDF2_SHA256
  new DataView(header.buffer).setUint32(MAGIC.length + 2, ITERATIONS)
  crypto.getRandomValues(header.subarray(MAGIC.length + 6, MAGIC.length + 6 + SALT_BYTES))
  crypto.getRandomValues(header.subarray(HEADER_BYTES - IV_BYTES))
  const parsed = readEncryptedHeader(header, HEADER_BYTES + TAG_BYTES)
  const key = await deriveKey(password, parsed.salt, ITERATIONS, 'encrypt')
  checkCancelled(signal)
  const plaintext = await archive.arrayBuffer()
  let ciphertext: ArrayBuffer
  try {
    checkCancelled(signal)
    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: parsed.iv, additionalData: header, tagLength: 128 }, key, plaintext,
    )
  } finally {
    new Uint8Array(plaintext).fill(0)
  }
  checkCancelled(signal)
  const encrypted = new Blob([header, ciphertext], { type: 'application/octet-stream' })
  onProgress?.({ stage: 'finalizing', message: 'Validating encrypted backup' })
  // Verify authentication and payload equality before offering the download.
  const verified = await decryptLifeLineArchive(encrypted, password, undefined, signal)
  if (verified.size !== archive.size || !(await sameBytes(verified, archive, signal))) throw new Error('Encrypted backup validation failed.')
  checkCancelled(signal)
  return encrypted
}

async function sameBytes(left: Blob, right: Blob, signal?: AbortSignal) {
  const chunkSize = 1024 * 1024
  for (let offset = 0; offset < left.size; offset += chunkSize) {
    checkCancelled(signal)
    const [a, b] = await Promise.all([
      left.slice(offset, offset + chunkSize).arrayBuffer(),
      right.slice(offset, offset + chunkSize).arrayBuffer(),
    ])
    if (!matches(new Uint8Array(a), new Uint8Array(b))) return false
  }
  return true
}

export async function decryptLifeLineArchive(
  file: Blob, password: string,
  onProgress?: (progress: ArchiveProgress) => void, signal?: AbortSignal,
): Promise<Blob> {
  checkCancelled(signal)
  const prefix = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())
  if (!matches(prefix, MAGIC)) throw new Error('This is not an encrypted Life Line backup.')
  const header = readEncryptedHeader(prefix, file.size)
  onProgress?.({ stage: 'decrypting', message: 'Unlocking encrypted backup' })
  const key = await deriveKey(password, header.salt, header.iterations, 'decrypt')
  checkCancelled(signal)
  const ciphertext = await file.slice(HEADER_BYTES).arrayBuffer()
  checkCancelled(signal)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: header.iv, additionalData: header.bytes, tagLength: 128 }, key, ciphertext,
    )
    try {
      checkCancelled(signal)
      return new Blob([plaintext], { type: 'application/zip' })
    } finally {
      new Uint8Array(plaintext).fill(0)
    }
  } catch (error) {
    if (error instanceof ArchiveCancelledError) throw error
    throw new Error('Unable to decrypt this backup. The password may be incorrect or the file may be damaged.')
  } finally {
    new Uint8Array(ciphertext).fill(0)
  }
}
