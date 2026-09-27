import { useEffect, useRef, useState } from 'react'
import type { Media } from './types'
import { createImageThumbnail, saveMediaFile } from './mediaStorage'
import { attachMedia, detachMedia, reorderMedia } from './mediaDomain'
import { db } from './db'
import { useMediaUrl } from './useMediaUrl'
import { importCaptureFiles } from './quickCaptureMedia'

export function AttachmentPanel(props:{mediaIds:string[];onChange:(ids:string[])=>void;compact?:boolean;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}) {
  return props.compact ? <CaptureAttachments {...props}/> : <FullAttachmentPanel {...props}/>
}
function CaptureAttachments({mediaIds,onChange,onBusyChange,disabled=false}:{mediaIds:string[];onChange:(ids:string[])=>void;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}) {
  const [media,setMedia] = useState<Media[]>([])
  const [busy,setBusy] = useState(false)
  const [errors,setErrors] = useState<string[]>([])
  const importing = useRef(false)
  const photoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {let active=true;void db.media.bulkGet(mediaIds).then(items => {if(active)setMedia(items.filter((item):item is Media => Boolean(item)))});return () => {active=false}},[mediaIds])
  async function add(files:FileList|null) {
    if (!files?.length || importing.current || disabled) return
    importing.current=true;setBusy(true);onBusyChange?.(true);setErrors([])
    try {const result=await importCaptureFiles(Array.from(files),mediaIds);onChange(result.ids);setErrors(result.errors)}
    catch {setErrors(['Files could not be added. Your text is safe; try again or save without them.'])}
    finally {importing.current=false;setBusy(false);onBusyChange?.(false)}
  }
  return <section className="attachments capture-attachments">
    <div className="capture-file-actions"><button type="button" className="quiet" disabled={busy || disabled} onClick={() => photoInput.current?.click()}>Add Photo</button><input ref={photoInput} hidden type="file" accept="image/*" multiple disabled={busy || disabled} onChange={event => {void add(event.target.files);event.target.value=''}}/><button type="button" className="quiet" disabled={busy || disabled} onClick={() => fileInput.current?.click()}>Add File</button><input ref={fileInput} hidden type="file" multiple disabled={busy || disabled} onChange={event => {void add(event.target.files);event.target.value=''}}/></div>
    {busy && <p role="status">Adding files locally… Your text stays safe.</p>}
    {errors.length > 0 && <div className="capture-error" role="alert">{errors.map(error => <p key={error}>{error}</p>)}</div>}
    <div className="attachment-list">{media.map((item,index) => <Attachment key={item.id} media={item} compact busy={busy || disabled} index={index} total={media.length} onMove={() => {}} onDetach={() => onChange(mediaIds.filter(id => id !== item.id))}/>)}</div>
    {mediaIds.some(id => !media.some(item => item.id === id)) && !busy && <p>Some draft files may be unavailable. Saving will omit deleted attachments.</p>}
  </section>
}

function FullAttachmentPanel({mediaIds,onChange}:{mediaIds:string[];onChange:(ids:string[])=>void}){const [media,setMedia]=useState<Media[]>([]),[status,setStatus]=useState('');useEffect(()=>{db.media.bulkGet(mediaIds).then(items=>setMedia(items.filter(Boolean) as Media[]))},[mediaIds]);async function importFiles(files:FileList|null){if(!files?.length||status==='Importing…')return;setStatus('Importing…');const ids=[...mediaIds];for(const file of Array.from(files)){try{let item=await saveMediaFile(file);if(item.mediaType==='image')item=await createImageThumbnail(item);ids.push(item.id)}catch{setStatus(`Could not import ${file.name}`)}}onChange([...new Set(ids)]);setStatus('Ready')}return <section className="attachments" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();importFiles(e.dataTransfer.files)}}><div className="editor-head"><span className="eyebrow">ATTACHMENTS {status&&`· ${status}`}</span><label className="quiet">Select files<input hidden type="file" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt" onChange={e=>importFiles(e.target.files)}/></label></div>{!media.length&&<p className="empty">No media attached yet.</p>}<div className="attachment-list">{media.map((item,index)=><Attachment key={item.id} media={item} onDetach={()=>onChange(detachMedia({mediaIds} as never,item.id).mediaIds)} onMove={to=>onChange(reorderMedia({mediaIds} as never,index,to).mediaIds)} index={index} total={media.length}/>)}</div></section>}
function Attachment({media,onDetach,onMove,index,total,compact=false,busy=false}:{media:Media;onDetach:()=>void;onMove:(to:number)=>void;index:number;total:number;compact?:boolean;busy?:boolean}){const {url}=useMediaUrl(media,'thumbnail',media.mediaType!=='document');return <article className="attachment"><Preview media={media} url={url}/><div><strong>{media.title||media.filename}</strong><small>{media.mediaType} · {(media.byteSize/1024).toFixed(0)} KB</small>{!compact && <><input placeholder="Title" defaultValue={media.title} onBlur={async e=>db.media.put({...media,title:e.target.value})}/><input placeholder="Caption" defaultValue={media.caption} onBlur={async e=>db.media.put({...media,caption:e.target.value})}/></>}</div><div>{!compact && <><button type="button" disabled={!index} onClick={()=>onMove(index-1)}>↑</button><button type="button" disabled={index===total-1} onClick={()=>onMove(index+1)}>↓</button></>}<button type="button" className="danger" disabled={busy} onClick={onDetach}>Remove</button></div></article>}
function Preview({media,url}:{media:Media;url?:string}){if(media.mediaType==='image')return url?<img src={url} alt={media.caption||media.filename}/>:<span>Image</span>;if(media.mediaType==='audio')return url?<audio controls src={url}/>:<span>Audio</span>;if(media.mediaType==='video')return url?<video controls src={url}/>:<span>Video</span>;return <span>Document</span>}
