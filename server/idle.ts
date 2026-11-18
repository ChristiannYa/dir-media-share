// Shutting down by itself when nobody uses the app: after
// serverSettings.idleShutdownMinutes without any activity (0 = never), the
// server stops like the shutdown button does.
//
// Activity is any request of the backend (folders, stills, previews, the
// original files a video plays from…) from any device; one still running (a
// big upload, a compression, a video being downloaded) counts the whole time.
// Not counted: the stream of preview events, which an open tab keeps
// connected even when nobody touches it.
//
// Work running in the background with no request open (the compress queue,
// server/compressQueue.ts) holds it off through `keepAwake`: each check while
// it's busy pushes the idle time back, so the timer never runs out under it
// and only starts counting once that work is done.
//
// Vite reloads the server's files after an edit (server/vitePlugin.ts), so the
// state lives on globalThis: one timer and one count for the whole process,
// whichever version of this file is loaded.

import type { ServerResponse } from 'node:http'
import { ROUTE_JOB_EVENTS } from './consts/routes.ts'
import { IDLE_CHECK_MS } from './consts/shutdown.ts'
import { serverSettings } from './settings.ts'
import { shutdownNow } from './shutdown.ts'

/** Requests that don't count as activity */
const IGNORED = new Set([ROUTE_JOB_EVENTS])

interface IdleState {
  /** When the last request started or ended (ms since 1970) */
  lastActivity: number
  /** Requests still running */
  running: number
  timer: ReturnType<typeof setInterval> | null
  /** The latest loaded version's settings and shutdown */
  minutes: () => number
  stop: (reason: string) => Promise<void>
  stopping: boolean
  /** Background work by name → true while it's busy (keepAwake) */
  keepers: Map<string, () => boolean>
}

const KEY = Symbol.for('med.idleShutdown')
const store = globalThis as typeof globalThis & { [KEY]?: IdleState }
const state: IdleState = (store[KEY] ??= {
  lastActivity: Date.now(),
  running: 0,
  timer: null,
  minutes: () => 0,
  stop: async () => {},
  stopping: false,
  keepers: new Map(),
})
// a state made by an older version of this file has none yet
state.keepers ??= new Map()
state.minutes = () => serverSettings.idleShutdownMinutes
state.stop = shutdownNow

/** True while some background work (keepAwake) is still busy */
function busyInBackground(): boolean {
  for (const busy of state.keepers.values()) {
    try {
      if (busy()) return true
    } catch {
      // a broken check never keeps the server up
    }
  }
  return false
}

function check() {
  const minutes = state.minutes()
  if (minutes <= 0 || state.running > 0 || state.stopping) return
  if (busyInBackground()) {
    // extend the idle time before it can run out: it starts over once the work is done
    state.lastActivity = Date.now()
    return
  }
  if (Date.now() - state.lastActivity < minutes * 60_000) return
  state.stopping = true
  void state.stop(`no activity for ${minutes} min`)
}

/** Starts the idle check (once per process; loading this file again keeps the running one) */
export function startIdleShutdown() {
  if (state.timer) return
  state.lastActivity = Date.now()
  state.timer = setInterval(check, IDLE_CHECK_MS)
  state.timer.unref() // never what keeps the process alive
}

/**
 * Keeps the server from shutting down when idle while `busy()` is true
 * (checked every IDLE_CHECK_MS). `name` replaces an earlier one of the same
 * name, so a reloaded file doesn't add a second
 */
export function keepAwake(name: string, busy: () => boolean) {
  state.keepers.set(name, busy)
}

/** Counts as activity now (e.g. background work just ended): the idle time starts over */
export function touchActivity() {
  state.lastActivity = Date.now()
}

/** A request of the backend started: activity until it ends */
export function trackActivity(pathname: string, res: ServerResponse) {
  if (IGNORED.has(pathname)) return
  state.lastActivity = Date.now()
  state.running++
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    state.running--
    state.lastActivity = Date.now()
  }
  // finished, or cut off (the browser went away)
  res.once('finish', end)
  res.once('close', end)
}
