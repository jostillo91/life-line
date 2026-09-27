import { useEffect, useRef, useState } from 'react'
import type { ArchiveProgress, InspectedLifeLineArchive, RestoreResult } from './archiveService'
import { decryptLifeLineArchive, encryptLifeLineArchive, inspectBackupContainer, MIN_BACKUP_PASSWORD_LENGTH, type BackupContainer } from './encryptedArchive'
import { formatBytes } from './mediaPresentation'
import { requestStoragePersistence, storageInfo, type MediaStorageInfo } from './mediaStorage'
import { persistenceLabel } from './pwaSafety'
import type { Archive } from './types'
import { RecoveryCenter, useDeletedMemories } from './RecoveryCenter'

const lastRestoreKey = 'life-line:last-restore'
const largeArchiveWarningBytes = 1024 ** 3

export function DataManagementView({ data, onChanged, onExportJson, onImportJson }: {
  data: Archive
  onChanged: () => Promise<void>
  onExportJson: () => void
  onImportJson: (file: File) => Promise<void>
}) {
  const [recoveryOpen,setRecoveryOpen]=useState(false)
  const deleted=useDeletedMemories()
  const [progress, setProgress] = useState<ArchiveProgress>()
  const [error, setError] = useState('')
  const [inspected, setInspected] = useState<InspectedLifeLineArchive>()
  const [backupKind, setBackupKind] = useState<'standard' | 'encrypted'>('standard')
  const [backupPassword, setBackupPassword] = useState('')
  const [backupConfirmation, setBackupConfirmation] = useState('')
  const [showBackupPassword, setShowBackupPassword] = useState(false)
  const [lockedFile, setLockedFile] = useState<File>()
  const [lockedContainer, setLockedContainer] = useState<Extract<BackupContainer, { kind: 'encrypted' }>>()
  const [restorePassword, setRestorePassword] = useState('')
  const [showRestorePassword, setShowRestorePassword] = useState(false)
  const [replaceConfirmation, setReplaceConfirmation] = useState('')
  const [result, setResult] = useState<RestoreResult>()
  const [storage, setStorage] = useState<MediaStorageInfo>()
  const [persistenceResult,setPersistenceResult] = useState('')
  const [requestingPersistence,setRequestingPersistence] = useState(false)
  const [lastRestore, setLastRestore] = useState(() => localStorage.getItem(lastRestoreKey))
  const controller = useRef<AbortController | undefined>(undefined)
  const working = Boolean(progress && progress.stage !== 'complete')
  const mediaBytes = (data.media ?? []).reduce((sum, item) => sum + item.byteSize, 0)

  useEffect(() => { void storageInfo().then(setStorage) }, [])
  async function requestPersistence() {
    setRequestingPersistence(true)
    const result=await requestStoragePersistence()
    setPersistenceResult(result === 'granted' ? 'Persistent storage granted. Keep regular backups; this is not a permanent-data guarantee.' : result === 'denied' ? 'This browser did not grant persistence. Your archive is unchanged; keep regular backups.' : result === 'unsupported' ? 'Storage persistence is not supported here. Backups still work.' : 'Persistence could not be checked. Your archive is unchanged.')
    setStorage(await storageInfo());setRequestingPersistence(false)
  }

  function beginOperation() {
    controller.current?.abort()
    controller.current = new AbortController()
    setError('')
    setResult(undefined)
    return controller.current
  }

  async function backup() {
    if (backupKind === 'encrypted') {
      if (backupPassword.length < MIN_BACKUP_PASSWORD_LENGTH) {
        setError(`Use a password of at least ${MIN_BACKUP_PASSWORD_LENGTH} characters.`)
        return
      }
      if (backupPassword !== backupConfirmation) {
        setError('The backup passwords do not match.')
        return
      }
    }
    const operation = beginOperation()
    try {
      const { createLifeLineArchive } = await import('./archiveService')
      const created = await createLifeLineArchive(progress => {
        setProgress(backupKind === 'encrypted' && progress.stage === 'complete'
          ? { stage: 'finalizing', message: 'Archive prepared for encryption' }
          : progress)
      }, operation.signal)
      let blob = created.blob
      let filename = created.filename
      if (backupKind === 'encrypted') {
        blob = await encryptLifeLineArchive(created.blob, backupPassword, setProgress, operation.signal)
        filename = created.filename.replace(/\.zip$/, '.encrypted')
      }
      if (operation.signal.aborted) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setProgress({ stage: 'complete', message: 'Backup ready' })
    } catch (caught) {
      if (!isCancellation(caught)) setError(message(caught))
      setProgress(undefined)
    } finally {
      setBackupPassword('')
      setBackupConfirmation('')
    }
  }

  async function inspect(file: File) {
    const operation = beginOperation()
    setInspected(undefined)
    setLockedFile(undefined)
    setLockedContainer(undefined)
    setRestorePassword('')
    setReplaceConfirmation('')
    try {
      const container = await inspectBackupContainer(file)
      if (container.kind === 'encrypted') {
        setLockedFile(file)
        setLockedContainer(container)
        setProgress(undefined)
        return
      }
      const { inspectLifeLineArchive } = await import('./archiveService')
      const preview = await inspectLifeLineArchive(file, setProgress, operation.signal)
      setInspected(preview)
      setProgress(undefined)
    } catch (caught) {
      if (!isCancellation(caught)) setError(message(caught))
      setProgress(undefined)
    }
  }

  async function unlock() {
    if (!lockedFile) return
    const operation = beginOperation()
    try {
      const archive = await decryptLifeLineArchive(lockedFile, restorePassword, setProgress, operation.signal)
      const { inspectLifeLineArchive } = await import('./archiveService')
      const preview = await inspectLifeLineArchive(archive, setProgress, operation.signal)
      if (operation.signal.aborted) return
      setInspected(preview)
      setLockedFile(undefined)
      setLockedContainer(undefined)
      setProgress(undefined)
    } catch (caught) {
      if (!isCancellation(caught)) setError(message(caught))
      setProgress(undefined)
    } finally {
      setRestorePassword('')
    }
  }

  async function restore(mode: 'merge' | 'replace') {
    if (!inspected) return
    const operation = beginOperation()
    try {
      const { restoreLifeLineArchive } = await import('./archiveService')
      const restored = await restoreLifeLineArchive(inspected, mode, setProgress, operation.signal)
      setResult(restored)
      setProgress({ stage: 'complete', message: 'Restore complete' })
      await onChanged()
      const history = JSON.stringify({ restoredAt: new Date().toISOString(), archiveVersion: inspected.manifest.archiveVersion, mode })
      localStorage.setItem(lastRestoreKey, history)
      setLastRestore(history)
      setInspected(undefined)
      setReplaceConfirmation('')
      setStorage(await storageInfo())
    } catch (caught) {
      if (!isCancellation(caught)) setError(message(caught))
      setProgress(undefined)
    }
  }

  return (
    recoveryOpen ? <><RecoveryCenter entries={deleted.entries} data={data} onChanged={onChanged} onClose={()=>setRecoveryOpen(false)}/>{deleted.error && <p role="alert">{deleted.error}</p>}</> :
    <section className="manager data-management" data-pwa-busy={working}>
      <div className="manager-head"><div><span className="eyebrow">LOCAL DATA SAFETY</span><h2>Backup & Restore</h2></div></div>
      <p className="data-management-intro">Full backups include structured records and byte-identical original media. Everything is created and restored locally in this browser.</p>
      <p className="data-detail">Life Line stores your archive locally on this device. Keep regular backups even when the app is installed.</p>

      <div className="data-panels">
        <section className="data-panel"><span className="eyebrow">RECOVERABLE MEMORIES</span><h3>Recovery Center</h3><p>{deleted.entries?.length ?? '…'} deleted memor{deleted.entries?.length===1?'y':'ies'} · no automatic expiration</p><button className="quiet" disabled={working} onClick={()=>setRecoveryOpen(true)}>Open Recovery Center</button>{deleted.error && <p role="alert">{deleted.error}</p>}</section>
        <section className="data-panel">
          <span className="eyebrow">BACK UP</span>
          <h3>Export Full Life Line Archive</h3>
          <p>Both options include live and deleted Memories, durable revision history, relationships, media metadata, and original files.</p>
          <p className="data-detail">{deleted.entries?.length ?? '…'} recoverable deleted memor{deleted.entries?.length===1?'y is':'ies are'} included in addition to the live count below.</p>
          <p className="data-detail">{data.entries.length} memories · {(data.media ?? []).length} media items · {formatBytes(mediaBytes)} original media</p>
          {mediaBytes >= largeArchiveWarningBytes && <p className="capacity-warning">This backup exceeds 1 GB. Browser memory and download limits vary; keep Life Line open and consider smaller source libraries if creation fails.</p>}
          <div className="backup-kind-options" role="radiogroup" aria-label="Backup protection">
            <label><input type="radio" name="backup-kind" value="standard" checked={backupKind === 'standard'} disabled={working} onChange={() => { setBackupKind('standard'); setBackupPassword(''); setBackupConfirmation('') }}/><span><strong>Standard Backup</strong><small>ZIP file · not encrypted · easiest compatibility</small></span></label>
            <label><input type="radio" name="backup-kind" value="encrypted" checked={backupKind === 'encrypted'} disabled={working} onChange={() => setBackupKind('encrypted')}/><span><strong>Encrypted Backup</strong><small>Password-protected file · password required to restore</small></span></label>
          </div>
          {backupKind === 'encrypted' && <div className="backup-password-fields">
            <label>Password<input type={showBackupPassword ? 'text' : 'password'} autoComplete="new-password" value={backupPassword} disabled={working} onChange={event => setBackupPassword(event.target.value)} minLength={MIN_BACKUP_PASSWORD_LENGTH}/></label>
            <label>Confirm password<input type={showBackupPassword ? 'text' : 'password'} autoComplete="new-password" value={backupConfirmation} disabled={working} onChange={event => setBackupConfirmation(event.target.value)} minLength={MIN_BACKUP_PASSWORD_LENGTH}/></label>
            <label className="password-visibility"><input type="checkbox" checked={showBackupPassword} onChange={event => setShowBackupPassword(event.target.checked)}/> Show passwords</label>
            <p>Life Line cannot recover an encrypted backup if you forget its password.</p>
            <p>Encrypted backups need additional browser memory while they are created.</p>
          </div>}
          <button className="primary" disabled={working} onClick={backup}>{backupKind === 'encrypted' ? 'Create Encrypted Backup' : 'Back Up Life Line'}</button>
        </section>

        <section className="data-panel">
          <span className="eyebrow">RESTORE</span>
          <h3>Restore Life Line Archive</h3>
          <p>Select a standard ZIP or encrypted Life Line backup. Restore options appear only after validation.</p>
          <label className="quiet archive-file-picker">Choose archive<input type="file" accept=".zip,.encrypted,application/zip,application/octet-stream" disabled={working} onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void inspect(file)
          }}/></label>
        </section>

        <section className="data-panel">
          <span className="eyebrow">PORTABLE DATA</span>
          <h3>JSON Data Export</h3>
          <p>Structured records including Recovery Center and durable revision history. Original media files are not included.</p>
          <div className="portable-actions">
            <button className="quiet" disabled={working} onClick={onExportJson}>Export JSON</button>
            <label className="quiet">Import JSON<input type="file" accept="application/json" disabled={working} onChange={event => event.target.files?.[0] && void onImportJson(event.target.files[0])}/></label>
          </div>
        </section>

        <section className="data-panel">
          <span className="eyebrow">LOCAL STORAGE</span>
          <h3>Current browser storage</h3>
          <p>{storageSummary(storage)}</p>
          <p>{persistenceLabel(storage?.persistent)}</p>
          <p className="data-detail">Optional persistence asks the browser to reduce automatic storage eviction. It cannot protect against clearing site data, device loss or browser limits.</p>
          {typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function' && !storage?.persistent && !persistenceResult && <button className="quiet" disabled={working || requestingPersistence} onClick={() => void requestPersistence()}>Request persistent storage</button>}
          {persistenceResult && <p role="status">{persistenceResult}</p>}
          {lastRestore && <p className="data-detail">Last restore: {formatRestoreHistory(lastRestore)}</p>}
        </section>
      </div>

      {progress && (
        <div className="archive-progress" aria-live="polite">
          <strong>{progress.message}</strong>
          {progress.total !== undefined && <span>{progress.current ?? 0} / {progress.total}</span>}
          {progress.totalBytes !== undefined && <progress max={Math.max(1, progress.totalBytes)} value={progress.processedBytes ?? 0}/>} 
          {working && progress.stage !== 'restoring' && <button className="quiet" onClick={() => controller.current?.abort()}>Cancel</button>}
        </div>
      )}
      {error && <p className="archive-error" role="alert">{error}</p>}
      {result && <p className="archive-success">Restore complete. {result.mode === 'merge' ? `${result.reusedMedia} duplicate media files reused; ${result.remappedIds} conflicting IDs safely remapped.` : 'The validated backup replaced the previous local archive.'}</p>}
      {lockedFile && lockedContainer && !inspected && <section className="restore-preview backup-unlock">
        <div><span className="eyebrow">ENCRYPTED BACKUP</span><h3>Unlock to preview</h3></div>
        <p>This is an encrypted Life Line backup (container v{lockedContainer.version}, {lockedContainer.kdf}). Its contents are hidden until you enter the password.</p>
        <label>Password<input type={showRestorePassword ? 'text' : 'password'} autoComplete="current-password" value={restorePassword} disabled={working} onChange={event => setRestorePassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void unlock() }}/></label>
        <label className="password-visibility"><input type="checkbox" checked={showRestorePassword} onChange={event => setShowRestorePassword(event.target.checked)}/> Show password</label>
        <div className="portable-actions"><button className="primary" disabled={working || !restorePassword} onClick={unlock}>Unlock and validate</button><button className="quiet" disabled={working} onClick={() => { setLockedFile(undefined); setLockedContainer(undefined); setRestorePassword(''); setError('') }}>Cancel</button></div>
      </section>}
      {inspected && (
        <RestorePreview
          inspected={inspected}
          replaceConfirmation={replaceConfirmation}
          onReplaceConfirmation={setReplaceConfirmation}
          onMerge={() => restore('merge')}
          onReplace={() => restore('replace')}
          disabled={working}
        />
      )}
    </section>
  )
}

function RestorePreview({ inspected, replaceConfirmation, onReplaceConfirmation, onMerge, onReplace, disabled }: {
  inspected: InspectedLifeLineArchive
  replaceConfirmation: string
  onReplaceConfirmation: (value: string) => void
  onMerge: () => void
  onReplace: () => void
  disabled: boolean
}) {
  const { manifest } = inspected
  return (
    <section className="restore-preview">
      <div><span className="eyebrow">VALIDATED ARCHIVE</span><h3>Ready to restore</h3></div>
      <dl>
        <dt>Created</dt><dd>{new Date(manifest.exportedAt).toLocaleString()}</dd>
        <dt>Archive version</dt><dd>{manifest.archiveVersion}</dd>
        <dt>Memories</dt><dd>{manifest.counts.memories}</dd>
        <dt>Deleted memories included</dt><dd>{manifest.counts.deletedMemories ?? 0}</dd>
        <dt>Previous versions</dt><dd>{manifest.counts.revisions ?? 0}</dd>
        <dt>Media</dt><dd>{manifest.counts.media}</dd>
        <dt>People</dt><dd>{manifest.counts.people}</dd>
        <dt>Places</dt><dd>{manifest.counts.places}</dd>
        <dt>Tags</dt><dd>{manifest.counts.tags}</dd>
        <dt>Life Eras</dt><dd>{manifest.counts.eras}</dd>
        <dt>Original media</dt><dd>{formatBytes(manifest.totalMediaBytes)}</dd>
      </dl>
      {inspected.storageWarning && <p className="capacity-warning">{inspected.storageWarning}</p>}
      <div className="restore-options">
        <div>
          <h3>Merge Into Current Life Line</h3>
          <p>Keeps local data, reuses matching media, and safely remaps conflicting IDs.</p>
          <button className="primary" disabled={disabled} onClick={onMerge}>Merge archive</button>
        </div>
        <div className="replace-option">
          <h3>Replace Current Life Line</h3>
          <p>Replaces all current local records, revision history, and media after staged validation. Type <strong>REPLACE</strong> to confirm.</p>
          <input value={replaceConfirmation} onChange={event => onReplaceConfirmation(event.target.value)} aria-label="Type REPLACE to confirm"/>
          <button className="danger" disabled={disabled || replaceConfirmation !== 'REPLACE' || inspected.storageWarning?.includes('exceed')} onClick={onReplace}>Replace current Life Line</button>
        </div>
      </div>
    </section>
  )
}

function storageSummary(info?: MediaStorageInfo) {
  if (!info) return 'Checking browser storage…'
  if (info.usage === undefined || info.quota === undefined) return 'Browser storage estimate unavailable.'
  return `${formatBytes(info.usage)} used · ${formatBytes(info.quota)} approximate quota · ${formatBytes(Math.max(0, info.quota - info.usage))} approximately available`
}

function formatRestoreHistory(value: string) {
  try {
    const parsed = JSON.parse(value) as { restoredAt: string; archiveVersion: number; mode: string }
    return `${new Date(parsed.restoredAt).toLocaleString()} · archive v${parsed.archiveVersion} · ${parsed.mode}`
  } catch { return 'Unavailable' }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'The archive operation failed.'
}

function isCancellation(error: unknown) {
  return error instanceof Error && error.name === 'ArchiveCancelledError'
}
