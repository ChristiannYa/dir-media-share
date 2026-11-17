// Passcode login: POST /api/login checks the passcode and sets a session
// cookie; every other backend route needs that cookie.
//
// The cookie holds when the session ends ("<end ms>.<signature>", 0 = never)
// signed with the passcode, so it can't be stretched, survives restarts, and
// changing the passcode logs every device out.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILS,
  LOGIN_MAX_LOCKOUT_MS,
  PASSWORD_ENV,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
} from './consts/server.ts'
import { serverSettings } from './settings.ts'

const raw = process.env[PASSWORD_ENV]
/** The passcode; null if unset or not only digits (every request is then refused) */
export const password = raw && /^\d+$/.test(raw) ? raw : null

/** The signature of a session ending at `end` */
function sign(end: number): string {
  return createHmac('sha256', password ?? '').update(`med-session:${end}`).digest('hex')
}

/** Compares without stopping at the first difference, so timing leaks nothing */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * Compares hashes, which are always the same length: comparing the passcodes
 * themselves would answer a wrong-length guess faster, hinting at the length
 */
export function checkPasscode(given: string): boolean {
  return password !== null && sameSecret(sha256(given), sha256(password))
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

/**
 * When this browser's session ends (ms since 1970; 0 = never), or null if it
 * isn't logged in: no cookie, a forged or old one, or its time is up
 */
export function sessionEnd(req: IncomingMessage): number | null {
  if (!password) return null
  const match = /^(\d+)\.([0-9a-f]{64})$/.exec(readCookie(req, SESSION_COOKIE) ?? '')
  if (!match) return null
  const end = Number(match[1])
  if (!sameSecret(match[2]!, sign(end))) return null
  if (end !== 0 && end <= Date.now()) return null
  return end
}

export function isAuthorized(req: IncomingMessage): boolean {
  return sessionEnd(req) !== null
}

/** When a session started now ends (Settings → Server → Lock screen → Lock after; 0 = never) */
export function newSessionEnd(): number {
  const minutes = serverSettings.lockAfterMinutes
  return minutes > 0 ? Date.now() + minutes * 60_000 : 0
}

/** ms left of a session ending at `end`; null if it never ends */
export function remainingMs(end: number): number | null {
  return end === 0 ? null : Math.max(0, end - Date.now())
}

/** The Set-Cookie value that logs this browser in until `end` (0 = never) */
export function sessionCookie(end: number): string {
  const maxAge = end === 0 ? SESSION_MAX_AGE_S : Math.ceil((end - Date.now()) / 1000)
  return `${SESSION_COOKIE}=${end}.${sign(end)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
}

/** The Set-Cookie value that makes this browser drop its login */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

/** No WWW-Authenticate header: the lock screen asks, not the browser */
export function rejectUnauthorized(res: ServerResponse) {
  res.writeHead(401).end()
}

// ── Wrong guesses (per IP, in memory) ──

const failures = new Map<string, { count: number; until: number }>()

/** ms this IP still has to wait before trying again (0 = may try) */
export function lockoutLeft(ip: string): number {
  const f = failures.get(ip)
  return f ? Math.max(0, f.until - Date.now()) : 0
}

/** Counts a wrong passcode; returns how long the IP must now wait (0 = none yet) */
export function recordFailure(ip: string): number {
  const f = failures.get(ip) ?? { count: 0, until: 0 }
  f.count++
  if (f.count >= LOGIN_MAX_FAILS) {
    const wait = LOGIN_LOCKOUT_MS * 2 ** (f.count - LOGIN_MAX_FAILS)
    f.until = Date.now() + Math.min(wait, LOGIN_MAX_LOCKOUT_MS)
  }
  failures.set(ip, f)
  return lockoutLeft(ip)
}

export function clearFailures(ip: string) {
  failures.delete(ip)
}
