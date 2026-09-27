export type RemoteAIStatus = 'ready' | 'mock' | 'authentication_required' | 'unavailable'
import { isOnline, requireOnline } from './networkState'

function url(endpoint: string, suffix: string) { return `${endpoint.replace(/\/$/, '')}/${suffix}` }

export async function getRemoteAIStatus(endpoint: string, fetcher: typeof fetch = fetch): Promise<RemoteAIStatus> {
  if (!isOnline()) return 'unavailable'
  try {
    const response = await fetcher(url(endpoint, 'status'), { credentials: 'include', cache: 'no-store' })
    if (response.status === 401) return 'authentication_required'
    if (!response.ok) return 'unavailable'
    const body: unknown = await response.json()
    const status = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined
    return status === 'ready' || status === 'mock' ? status : 'unavailable'
  } catch { return 'unavailable' }
}

export async function signInToRemoteAI(endpoint: string, password: string, fetcher: typeof fetch = fetch): Promise<RemoteAIStatus> {
  requireOnline('Remote AI sign-in')
  let response: Response
  try {
    response = await fetcher(url(endpoint, 'session'), {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    })
  } catch { throw new Error('Live assistant is unavailable. Please retry.') }
  if (response.status === 401) throw new Error('Access password was not accepted.')
  if (response.status === 429) throw new Error('Too many sign-in attempts. Please wait a minute.')
  if (!response.ok) throw new Error('Could not sign in to the live assistant.')
  const body: unknown = await response.json()
  const status = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined
  return status === 'ready' || status === 'mock' ? status : 'unavailable'
}

export async function signOutOfRemoteAI(endpoint: string, fetcher: typeof fetch = fetch): Promise<void> {
  requireOnline('Remote AI sign-out')
  await fetcher(url(endpoint, 'session'), { method: 'DELETE', credentials: 'include', cache: 'no-store' })
}
