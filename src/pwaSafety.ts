let localWrites = 0
export async function trackLocalWrite<T>(operation:()=>Promise<T>):Promise<T> {
  localWrites++
  try {return await operation()} finally {localWrites--}
}
export function updateBlockReason(documentState:Pick<Document,'querySelector'|'activeElement'>,pending = localWrites) {
  if (pending) return 'Wait for local changes to finish saving before updating.'
  if (documentState.querySelector('.overlay,[role="dialog"],[role="alertdialog"],[data-pwa-busy="true"]')) return 'Finish and close the current editor, capture or archive operation before updating.'
  if (documentState.activeElement?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return 'Finish entering text before updating.'
  return undefined
}
export function canReloadAfterUpdate(requested:boolean,documentState:Pick<Document,'querySelector'|'activeElement'>) {
  return requested && !updateBlockReason(documentState)
}
export interface InstallPromptEvent extends Event {
  prompt():Promise<void>
  userChoice:Promise<{outcome:'accepted'|'dismissed'}>
}
export function persistenceLabel(persistent?:boolean) {
  return persistent === true ? 'Persistent storage granted' : persistent === false ? 'Persistent storage not granted' : 'Persistence status unavailable in this browser'
}
