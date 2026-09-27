import type { Entry } from './types'

export const isDeletedMemory = (entry:Entry) => entry.deletedAt !== undefined
export const liveMemories = (entries:Entry[]) => entries.filter(entry => !isDeletedMemory(entry))
export const deletedMemories = (entries:Entry[]) => entries.filter(isDeletedMemory).sort((a,b) => b.deletedAt!.localeCompare(a.deletedAt!) || a.id.localeCompare(b.id))
export const validDeletionTimestamp = (value:unknown) => value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
export function requirePurgeConfirmation(value:string,count:number) {
  if (!count || value !== `DELETE ${count}`) throw new Error(`Type DELETE ${count} to confirm permanent removal.`)
}
