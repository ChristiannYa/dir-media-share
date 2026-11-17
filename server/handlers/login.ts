import {
  checkPasscode,
  clearedSessionCookie,
  clearFailures,
  lockoutLeft,
  newSessionEnd,
  password,
  recordFailure,
  remainingMs,
  sessionCookie,
  sessionEnd,
} from '../auth.ts'
import { readJson, sendJson, type Handler } from '../http.ts'

/** A passcode is a few digits; anything far bigger isn't a real request */
const MAX_BODY_BYTES = 1024

/**
 * GET /api/session : logged in?, ms until it locks by itself (null = never),
 * and the passcode's length, so the lock screen can unlock as soon as it's
 * typed. Time left rather than the end time, so a device whose clock is off
 * still counts down right.
 */
export const session: Handler = async (req, res) => {
  const end = sessionEnd(req)
  sendJson(res, {
    unlocked: end !== null,
    remainingMs: end === null ? null : remainingMs(end),
    passcodeLength: password?.length ?? null,
  })
}

/**
 * POST /api/logout : clears this browser's session cookie (it's HttpOnly, so
 * the page can't). Other devices stay logged in.
 */
export const logout: Handler = async (_req, res) => {
  res.setHeader('Set-Cookie', clearedSessionCookie())
  sendJson(res, { ok: true })
}

/** POST /api/login { passcode } : sets the session cookie if it's right; answers the ms until it locks (null = never) */
export const login: Handler = async (req, res) => {
  const ip = req.socket.remoteAddress ?? ''
  const wait = lockoutLeft(ip)
  if (wait > 0) return sendJson(res, { error: 'Locked', retryAfter: wait }, 429)

  let given: unknown
  try {
    given = ((await readJson(req, MAX_BODY_BYTES)) as { passcode?: unknown } | null)?.passcode
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }

  if (typeof given !== 'string' || !checkPasscode(given)) {
    return sendJson(res, { error: 'Wrong passcode', retryAfter: recordFailure(ip) }, 401)
  }
  clearFailures(ip)
  const end = newSessionEnd()
  res.setHeader('Set-Cookie', sessionCookie(end))
  sendJson(res, { ok: true, remainingMs: remainingMs(end) })
}
