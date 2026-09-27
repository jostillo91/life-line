import { useEffect, useState } from 'react'
import { liveQuery } from 'dexie'
import { db } from './db'
import { dateLabel } from './date'
import { deletedMemories } from './recoveryDomain'
import { purgeDeletedMemories, restoreDeletedMemory } from './memoryRevisionService'
import { MemoryMediaGallery } from './MemoryMediaGallery'
import type { Archive, Entry } from './types'

export function useDeletedMemories() {
  const [entries,setEntries]=useState<Entry[]>()
  const [error,setError]=useState('')
  useEffect(() => {
    const subscription=liveQuery(async () => deletedMemories(await db.entries.toArray())).subscribe({next:setEntries,error:() => setError('Recovery Center could not read local memories. Try reopening this screen.')})
    return () => subscription.unsubscribe()
  },[])
  return {entries,error}
}

export function RecoveryCenter({entries,data,onChanged,onClose}:{entries?:Entry[];data:Archive;onChanged:()=>Promise<void>;onClose:()=>void}) {
  const [selectedId,setSelectedId]=useState<string>()
  const selected=entries?.find(entry=>entry.id===selectedId)
  const [targets,setTargets]=useState<Array<{id:string;deletedAt:string}>>()
  const [confirmation,setConfirmation]=useState('')
  const [working,setWorking]=useState(false)
  const [message,setMessage]=useState('')
  const [error,setError]=useState('')
  function confirmRemoval(items:Entry[]) {setTargets(items.map(entry=>({id:entry.id,deletedAt:entry.deletedAt!})));setConfirmation('');setError('')}
  async function restore() {
    if(!selected || working) return
    setWorking(true);setError('')
    try {
      const result=await restoreDeletedMemory(selected.id,selected.deletedAt)
      await onChanged();setSelectedId(undefined)
      setMessage(`Memory restored. ${result.warnings.join(' ')}`)
    } catch(cause) {setError(cause instanceof Error ? cause.message : 'Restore failed; your memory remains in Recovery Center.')}
    finally {setWorking(false)}
  }
  async function permanentlyDelete() {
    if(!targets || working) return
    setWorking(true);setError('')
    try {
      const count=await purgeDeletedMemories(targets,confirmation)
      setTargets(undefined);setSelectedId(undefined);await onChanged()
      setMessage(`${count} memor${count===1?'y':'ies'} permanently removed with their revision history. Media files were kept.`)
    } catch(cause) {setError(cause instanceof Error ? cause.message : 'Permanent deletion failed; no cleanup was committed.')}
    finally {setWorking(false)}
  }
  return <section className="manager recovery-center" data-pwa-busy={working}>
    <div className="manager-head"><div><span className="eyebrow">LOCAL · RECOVERABLE MEMORIES</span><h2>Recovery Center</h2></div><button className="quiet" disabled={working} onClick={onClose}>Back to Backup & Restore</button></div>
    <p>Deleted memories stay here until you restore or deliberately remove them permanently. There is no automatic expiration. Full backups include these memories and their history.</p>
    {message && <p role="status" className="archive-success">{message}</p>}
    {error && <p role="alert" className="archive-error">{error}</p>}
    {entries === undefined ? <p>Loading deleted memories…</p> : <RecoveryList entries={entries} selectedId={selectedId} disabled={working} onSelect={id=>{setSelectedId(id);setMessage('')}}/>}
    {selected && <>
      <RecoveryPreview entry={selected} data={{...data,entries:[...data.entries,...(entries ?? [])]}}/>
      <div className="recovery-restore"><button className="primary" disabled={working} onClick={()=>void restore()}>Restore</button><p>Returns this memory to Timeline or Unsorted with the same identity and history. Missing references are reported, never recreated.</p></div>
    </>}
    {Boolean(entries?.length) && <details className="recovery-danger-zone"><summary>Permanent deletion · cannot be undone</summary><p>Removes the selected memory and its revisions from this device. Original media files are not deleted. Older backups may still contain it.</p>
      {selected && <button className="danger" disabled={working} onClick={()=>confirmRemoval([selected])}>Delete Permanently</button>}
      <p><button className="danger" disabled={working} onClick={()=>confirmRemoval(entries!)}>Empty Trash ({entries!.length})</button></p>
    </details>}
    {targets && <div className="overlay"><form className="editor recovery-confirm" role="alertdialog" aria-modal="true" aria-labelledby="purge-title" onSubmit={event=>{event.preventDefault();void permanentlyDelete()}} onKeyDown={event=>{
      if(event.key==='Escape' && !working)setTargets(undefined)
      if(event.key==='Tab') {
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)'))
        const first=controls[0],last=controls.at(-1)
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus()}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus()}
      }
    }}>
      <h3 id="purge-title">Permanently remove {targets.length} memor{targets.length===1?'y':'ies'}?</h3>
      <p>This cannot be undone. These memories and all their revisions will be removed. Media files remain in Media Library.</p>
      {error && <p role="alert">{error}</p>}
      <label>Type DELETE {targets.length} to confirm<input autoFocus value={confirmation} disabled={working} onChange={event=>setConfirmation(event.target.value)}/></label>
      <div className="editor-actions"><button className="quiet" type="button" disabled={working} onClick={()=>setTargets(undefined)}>Cancel</button><span/><button className="danger" disabled={working || confirmation!==`DELETE ${targets.length}`}>Permanently remove {targets.length} memor{targets.length===1?'y':'ies'}</button></div>
    </form></div>}
  </section>
}

export function RecoveryList({entries,selectedId,disabled=false,onSelect}:{entries:Entry[];selectedId?:string;disabled?:boolean;onSelect:(id:string)=>void}) {
  if(!entries.length) return <p className="empty">No deleted memories. Normal deletion remains recoverable here after Undo expires.</p>
  return <div className="recovery-list" aria-label="Deleted memories"><p>{entries.length} deleted memor{entries.length===1?'y':'ies'} · newest deletion first</p>{deletedMemories(entries).map(entry=><button key={entry.id} className={entry.id===selectedId?'active':''} disabled={disabled} onClick={()=>onSelect(entry.id)} aria-label={`Preview deleted memory: ${entry.title || 'Untitled memory'}`}><strong>{entry.title || 'Untitled memory'}</strong><span>{dateLabel(entry.eventDate)} · {entry.entryType} · {entry.mediaIds.length} attachment{entry.mediaIds.length===1?'':'s'}</span><small>Deleted {new Date(entry.deletedAt!).toLocaleString()}</small></button>)}</div>
}

export function RecoveryPreview({entry,data}:{entry:Entry;data:Archive}) {
  const references=[['People',entry.peopleIds,data.people],['Places',entry.placeIds,data.places],['Tags',entry.tagIds,data.tags]] as const
  return <article className="recovery-preview" aria-label="Deleted memory preview">
    <span className="eyebrow">READ-ONLY · DELETED MEMORY</span><h3>{entry.title || 'Untitled memory'}</h3><p>{dateLabel(entry.eventDate)} · {entry.entryType} · {entry.eventDate.confidence}</p>
    <p>Deleted {new Date(entry.deletedAt!).toLocaleString()} · Created {new Date(entry.createdAt).toLocaleString()}</p>
    <p className="memory-story">{entry.body}</p>{entry.notes && <p>Notes: {entry.notes}</p>}
    {references.map(([label,ids,items])=>ids.length>0 && <p key={label}>{label}: {ids.map(id=>items.find(item=>item.id===id)?.name ?? 'Unavailable reference').join(', ')}</p>)}
    {entry.relatedEntryIds.length>0 && <p>Related memories: {entry.relatedEntryIds.map(id=>{const item=data.entries.find(value=>value.id===id);return item ? `${item.title}${item.deletedAt?' (in Recovery Center)':''}` : 'Unavailable memory'}).join(', ')}</p>}
    {entry.mediaIds.some(id=>!data.media?.some(item=>item.id===id)) && <p>Some original attachments are no longer available. Restoration cannot recreate removed files.</p>}
    <MemoryMediaGallery entry={entry} media={data.media ?? []}/>
  </article>
}
