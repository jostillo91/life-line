import { useSyncExternalStore } from 'react'

export const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false
const subscribe = (callback:()=>void) => {
  window.addEventListener('online',callback);window.addEventListener('offline',callback)
  return () => {window.removeEventListener('online',callback);window.removeEventListener('offline',callback)}
}
export const useOnline = () => useSyncExternalStore(subscribe,isOnline,() => true)
export function requireOnline(feature:string) {
  if (!isOnline()) throw new Error(`${feature} is unavailable offline. Connect to the internet; your local archive remains available.`)
}
