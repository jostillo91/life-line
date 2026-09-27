import { useEffect, useRef, useState } from 'react'
import { AttachmentPanel } from './AttachmentPanel'
import { dateLabel } from './date'
import { captureDateError, captureSubmission, discardCaptureDraft, fastCaptureDate, hasCaptureContent, hasCaptureDraft, newCaptureDraft, QUICK_CAPTURE_SHORTCUT, readCaptureDraft, writeCaptureDraft } from './quickCaptureDomain'
import type { CaptureSaveResult } from './quickCaptureService'
import type { Entry } from './types'

export function QuickCaptureDraftBanner({available,onResume,onDiscard}:{available:boolean;onResume:()=>void;onDiscard:()=>void}) {
  if (!available) return null
  return <div className="capture-draft-banner"><span>Unfinished Quick Capture</span><button className="quiet" onClick={onResume}>Resume draft</button><button className="text-button" onClick={onDiscard}>Discard draft</button></div>
}

export function QuickCaptureView({draftKey,birthDate,onSave,onClose,onOpenEditor,onDraftChange,initialDraft}:{draftKey:string;birthDate?:string;onSave:(entry:Entry)=>Promise<CaptureSaveResult>;onClose:()=>void;onOpenEditor:(entry:Entry)=>void;onDraftChange:()=>void;initialDraft?:Entry}) {
  const [draft,setDraft] = useState(() => initialDraft ?? readCaptureDraft(draftKey) ?? newCaptureDraft())
  const [saved,setSaved] = useState<CaptureSaveResult>()
  const [saving,setSaving] = useState(false)
  const [addingFiles,setAddingFiles] = useState(false)
  const [error,setError] = useState('')
  const [draftError,setDraftError] = useState('')
  const bodyInput = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(draft)
  const saveCallback = useRef(onSave)
  const save = useRef(captureSubmission((entry:Entry) => saveCallback.current(entry)))
  const submitting = useRef(false)
  const completed = useRef(false)
  const dirty = useRef(false)
  latest.current=draft;saveCallback.current=onSave
  const busy = saving || addingFiles
  function preserve(value:Entry) {
    try {writeCaptureDraft(draftKey,value);setDraftError('');onDraftChange();return true}
    catch {setDraftError('Draft storage is unavailable. Keep this window open and save the memory before leaving.');return false}
  }
  function update(patch:Partial<Entry>) {
    dirty.current=true
    const next = {...latest.current,...patch}
    latest.current=next;setDraft(next);preserve(next);setError('')
  }
  function close() {
    if (busy || submitting.current) return
    if (completed.current || !dirty.current || !hasCaptureDraft(latest.current) || preserve(latest.current)) onClose()
  }
  useEffect(() => {
    const previous = document.activeElement
    bodyInput.current?.focus()
    return () => {if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector('.overlay')) previous.focus()}
  },[])
  useEffect(() => {
    const flush = () => {if (dirty.current && !completed.current) {try {writeCaptureDraft(draftKey,latest.current)} catch { /* Explicit warning is already shown on edits. */ }}}
    window.addEventListener('pagehide',flush)
    return () => {window.removeEventListener('pagehide',flush);flush()}
  },[draftKey])
  async function submit() {
    if (submitting.current || completed.current || addingFiles) return
    submitting.current=true;setSaving(true);setError('')
    try {
      // Flush first; failed canonical storage must leave the recoverable draft.
      preserve(latest.current)
      const result = await save.current(latest.current)
      completed.current=true
      try {discardCaptureDraft(draftKey);onDraftChange()}
      catch {setDraftError('Memory saved, but this browser could not clear its recoverable draft. Re-saving the same draft will not create a duplicate memory.')}
      setSaved(result)
    } catch (error) {setError(error instanceof Error ? error.message : 'Could not save. Your draft is still here; please try again.')}
    finally {submitting.current=false;setSaving(false)}
  }
  return <div className="overlay capture-overlay" onKeyDown={event => {
    if (event.key === 'Escape') {event.preventDefault();close()}
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled):not([type="hidden"]),summary')).filter(element => element.offsetParent !== null)
      const first=controls[0],last=controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus()}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus()}
    }
  }} onMouseDown={event => {if (event.target === event.currentTarget) close()}}>
    <section className="editor quick-capture" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title">
      <div className="editor-head"><div><span className="eyebrow">CAPTURE NOW · ORGANIZE LATER</span><h2 id="quick-capture-title">Quick Capture</h2></div><button type="button" className="close" aria-label="Close Quick Capture" disabled={busy} onClick={close}>×</button></div>
      {saved ? <CaptureSaved result={saved} onDone={close} onOpenEditor={() => onOpenEditor(saved.entry)}/> : <form onSubmit={event => {event.preventDefault();void submit()}}>
        <label className="capture-story-label" htmlFor="capture-story">What came to mind?</label>
        <textarea id="capture-story" ref={bodyInput} rows={7} value={draft.body} disabled={saving} placeholder="Write the thought before it slips away…" onChange={event => update({body:event.target.value})} onKeyDown={event => {if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault();void submit()}}}/>
        <p className="capture-hint">No title or date needed. Unknown dates go to Unsorted Memories.</p>
        <details className="capture-options">
          <summary>Title, date or attachments (optional)</summary>
          <fieldset disabled={saving}><label>Optional title<input value={draft.title} placeholder="Untitled memory" onChange={event => update({title:event.target.value})}/></label>
            <p className="capture-date-label">Date: {draft.eventDate.precision === 'unknown' ? 'Date unknown' : captureDateError(draft.eventDate) ? 'Optional date not set yet' : dateLabel(draft.eventDate)}{draft.eventDate.precision === 'unknown' ? '' : ` · ${draft.eventDate.confidence}`}</p>
            <div className="capture-date-actions" role="group" aria-label="Optional memory date">{([['unknown','Unknown'],['today','Today'],['yesterday','Yesterday'],['year','This year'],['approximate','Approximate…'],...(birthDate ? [['age','About my age…']] : [])] as Array<[Parameters<typeof fastCaptureDate>[0],string]>).map(([choice,label]) => <button className="quiet" type="button" key={choice} onClick={() => update({eventDate:fastCaptureDate(choice)})}>{label}</button>)}</div>
            {draft.eventDate.precision === 'approximate' && <label>Approximate year<input type="number" min="1000" max="9999" value={draft.eventDate.start ?? ''} placeholder="e.g. 2012" onChange={event => update({eventDate:{precision:'approximate',confidence:'approximate',start:event.target.value || undefined}})}/></label>}
            {draft.eventDate.precision === 'age' && <label>I was about this age<input type="number" min="0" value={draft.eventDate.age ?? ''} placeholder="e.g. 12" onChange={event => update({eventDate:{precision:'age',confidence:'approximate',age:event.target.value ? Number(event.target.value) : undefined}})}/><p>No exact date is inferred from an approximate age.</p></label>}
          </fieldset>
          <AttachmentPanel compact disabled={saving} mediaIds={draft.mediaIds} onChange={ids => update({mediaIds:ids})} onBusyChange={setAddingFiles}/>
        </details>
        {error && <p className="capture-error" role="alert">{error}</p>}
        <div className="capture-footer"><small>{QUICK_CAPTURE_SHORTCUT} to open · Ctrl/Cmd + Enter to save</small><div><button type="button" className="quiet" disabled={busy} onClick={close}>Close</button><button className="primary" disabled={busy || !hasCaptureContent(draft)}>{saving ? 'Saving…' : 'Save capture'}</button></div></div>
      </form>}
      {draftError && <p className="capture-error" role="alert">{draftError}</p>}
    </section>
  </div>
}

export function CaptureSaved({result,onDone,onOpenEditor}:{result:CaptureSaveResult;onDone:()=>void;onOpenEditor:()=>void}) {
  const unsorted = ['unknown','age'].includes(result.entry.eventDate.precision)
  return <div className="capture-saved"><h3>Memory saved</h3><p>{unsorted ? 'Available in Unsorted Memories. Organize it whenever you are ready.' : 'Available on Timeline. Organize it whenever you are ready.'}</p>{result.warnings.map(warning => <p className="capture-error" key={warning}>{warning}</p>)}<div><button className="primary" onClick={onDone} autoFocus>Done</button><button className="quiet" onClick={onOpenEditor}>Open full editor</button></div></div>
}
