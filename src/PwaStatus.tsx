import { useEffect, useRef, useState } from 'react'
import { useOnline } from './networkState'
import { canReloadAfterUpdate, updateBlockReason, type InstallPromptEvent } from './pwaSafety'

export function PwaStatus() {
  const online = useOnline()
  const [ready,setReady] = useState(false)
  const [update,setUpdate] = useState(false)
  const [install,setInstall] = useState<InstallPromptEvent>()
  const [message,setMessage] = useState('')
  const [applying,setApplying] = useState(false)
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const updateSW = useRef<(()=>Promise<void>) | undefined>(undefined)
  const requested = useRef(false)
  const wasOffline = useRef(!online)
  const updateCheck = useRef(false)
  useEffect(() => {
    const prompt = (event:Event) => {event.preventDefault();setInstall(event as InstallPromptEvent)}
    const installed = () => setInstall(undefined)
    window.addEventListener('beforeinstallprompt',prompt);window.addEventListener('appinstalled',installed)
    let active=true
    // No worker in ordinary Vite development or unsupported browsers.
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      void import('virtual:pwa-register').then(({registerSW}) => {
        if (!active) return
        updateSW.current=registerSW({
          onOfflineReady:() => {if(active)setReady(true)},
          onNeedRefresh:() => {if(active)setUpdate(true)},
          onRegisteredSW:(_url,value) => {registration.current=value;if(active && value?.active)setReady(true)},
          onNeedReload:() => {
            // An update accepted in another window must never reload this writer.
            if (canReloadAfterUpdate(requested.current,document)) window.location.reload()
            else {setUpdate(true);setApplying(false);setMessage('New version ready. Reload when your work is saved and closed.')}
          },
          onRegisterError:() => {if(active)setMessage('Offline installation is unavailable here. Life Line still works as a normal web app.')},
        })
      }).catch(() => {if(active)setMessage('Offline installation is unavailable in this browser.')})
    }
    return () => {active=false;window.removeEventListener('beforeinstallprompt',prompt);window.removeEventListener('appinstalled',installed)}
  },[])
  useEffect(() => {
    if (!online) wasOffline.current=true
    else if (wasOffline.current) {setMessage('Back online');wasOffline.current=false}
    // Check when returning online/focusing, not a loop of failing offline requests.
    const check = () => {
      if (!navigator.onLine || !registration.current || updateCheck.current) return
      updateCheck.current=true
      void registration.current.update().catch(() => {}).finally(() => {updateCheck.current=false})
    }
    if(online) check()
    window.addEventListener('focus',check)
    return () => window.removeEventListener('focus',check)
  },[online])
  async function applyUpdate() {
    const blocked=updateBlockReason(document)
    if (blocked) {setMessage(blocked);return}
    if (!online) {setMessage('Connect to the internet before applying an update.');return}
    // Recheck after yielding so queued editor-close saves can acquire their lock.
    await Promise.resolve()
    const pending=updateBlockReason(document)
    if(pending){setMessage(pending);return}
    requested.current=true;setApplying(true);setMessage('Applying update…')
    try {
      if(registration.current?.waiting) await updateSW.current?.()
      else window.location.reload()
    } catch {requested.current=false;setApplying(false);setMessage('Update could not be applied. Your archive is unchanged; try again later.')}
  }
  async function installApp() {
    if (!install) return
    setInstall(undefined)
    try {await install.prompt();await install.userChoice}
    catch {setMessage('Use your browser’s install or Add to Home Screen menu if available.')}
  }
  return <PwaStatusContent online={online} ready={ready} installable={Boolean(install)} update={update} applying={applying} message={message} onInstall={() => void installApp()} onUpdate={() => void applyUpdate()}/>
}

export function PwaStatusContent({online,ready=false,installable=false,update=false,applying=false,message='',onInstall,onUpdate}:{online:boolean;ready?:boolean;installable?:boolean;update?:boolean;applying?:boolean;message?:string;onInstall:()=>void;onUpdate:()=>void}) {
  return <div className="pwa-status" aria-live="polite">
    {!online && <span className="offline-indicator">Offline · local archive available</span>}
    {online && ready && <span>Ready for offline use</span>}
    {installable && <button type="button" className="text-button" onClick={onInstall}>Install Life Line</button>}
    {update && <span>Update available <button type="button" className="text-button" disabled={applying || !online} onClick={onUpdate}>Update when ready</button></span>}
    {message && <span>{message}</span>}
  </div>
}
