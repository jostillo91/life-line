import { describe, expect, it, vi } from 'vitest'
import { getRemoteAIStatus, signInToRemoteAI } from './remoteAISession'

describe('private live assistant session', () => {
  it('checks readiness without archive context and sends only the entered password to sign in', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ status: init?.method === 'POST' ? 'ready' : 'ready' }), { status: 200 })) as unknown as typeof fetch
    expect(await getRemoteAIStatus('/api/memory-assistant', fetcher)).toBe('ready')
    expect(await signInToRemoteAI('/api/memory-assistant', 'a test password', fetcher)).toBe('ready')
    expect(vi.mocked(fetcher).mock.calls[0][0]).toBe('/api/memory-assistant/status')
    expect(vi.mocked(fetcher).mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(vi.mocked(fetcher).mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ password: 'a test password' }) })
  })

  it('handles expired authentication and offline provider without affecting the archive', async () => {
    expect(await getRemoteAIStatus('/api/memory-assistant', vi.fn(async () => new Response('{"status":"mock"}', { status: 200 })) as unknown as typeof fetch)).toBe('mock')
    expect(await getRemoteAIStatus('/api/memory-assistant', vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch)).toBe('authentication_required')
    expect(await getRemoteAIStatus('/api/memory-assistant', vi.fn(async () => { throw Error('offline') }) as unknown as typeof fetch)).toBe('unavailable')
    await expect(signInToRemoteAI('/api/memory-assistant', 'wrong', vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch)).rejects.toThrow('not accepted')
  })
})
