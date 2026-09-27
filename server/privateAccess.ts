import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE = 'life_line_ai_session'
const digest = (value: string) => createHash('sha256').update(value).digest()

export interface Session { id: string; expiresAt: number }

export class PrivateAccess {
  private readonly expectedPassword: Buffer
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMinutes: number
  private readonly secure: boolean

  constructor(password: string, ttlMinutes = 480, secure = false) {
    if (password.length < 16 || password.length > 256) throw new Error('LIFE_LINE_AI_ACCESS_PASSWORD must be 16–256 characters')
    this.expectedPassword = digest(password)
    this.ttlMinutes = ttlMinutes
    this.secure = secure
  }

  signIn(password: string, now = Date.now()): { session: Session; cookie: string } | null {
    const supplied = digest(password)
    if (!timingSafeEqual(supplied, this.expectedPassword)) return null
    const token = randomBytes(32).toString('base64url')
    const session = { id: randomBytes(12).toString('hex'), expiresAt: now + this.ttlMinutes * 60_000 }
    this.sessions.set(digest(token).toString('hex'), session)
    this.prune(now)
    return { session, cookie: `${COOKIE}=${token}; HttpOnly; ${this.secure ? 'Secure; ' : ''}SameSite=Strict; Path=/api/memory-assistant; Max-Age=${this.ttlMinutes * 60}` }
  }

  get(cookieHeader: string | null, now = Date.now()): Session | null {
    const token = this.tokenFromCookie(cookieHeader)
    if (!token) return null
    const key = digest(token).toString('hex')
    const session = this.sessions.get(key)
    if (!session) return null
    if (session.expiresAt <= now) { this.sessions.delete(key); return null }
    return session
  }

  signOut(cookieHeader: string | null): string {
    const token = this.tokenFromCookie(cookieHeader)
    if (token) this.sessions.delete(digest(token).toString('hex'))
    return `${COOKIE}=; HttpOnly; ${this.secure ? 'Secure; ' : ''}SameSite=Strict; Path=/api/memory-assistant; Max-Age=0`
  }

  private tokenFromCookie(cookieHeader: string | null): string | null {
    const token = cookieHeader?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  }

  private prune(now: number) {
    if (this.sessions.size < 1000) return
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key)
  }
}
