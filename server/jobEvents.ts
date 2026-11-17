// Live progress of preview builds, pushed to the browser (see handlers/jobEvents.ts)
// so each card can show whether its preview is waiting, encoding, etc.

import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { isRunning } from './cache.ts'
import { sendJson } from './http.ts'

/** Which kind of preview a job builds */
export type JobKind = 'video' | 'folder'

export type JobState =
  /** Waiting for a free encoder (the "Encodes at once" setting's worth are busy) */
  | 'queued'
  /** ffmpeg is building the clip */
  | 'encoding'
  /** Finished */
  | 'done'
  | 'failed'
  /**
   * Stopped because the card asking for it left the screen (cancelJobs). A
   * page that still wants it asks again, which starts a new build.
   */
  | 'cancelled'

/** Why a build stopped when its job was cancelled (see cancelJobs) */
export class JobCancelled extends Error {
  constructor() {
    super('Cancelled: the preview is no longer on screen')
  }
}

/** The builds running (or queued) per preview, so they can be cancelled */
const running = new Map<string, Set<AbortController>>()

function jobKey(kind: JobKind, path: string): string {
  return `${kind}:${path}`
}

/**
 * Stops the builds of one preview, queued or encoding: a queued one leaves
 * the line, a running ffmpeg is killed and its half-written file deleted.
 * Returns how many were stopped.
 */
export function cancelJobs(kind: JobKind, path: string): number {
  const controllers = running.get(jobKey(kind, path))
  if (!controllers) return 0
  for (const controller of controllers) controller.abort(new JobCancelled())
  return controllers.size
}

export interface JobEvent {
  kind: JobKind
  /** Relative to the shared folder, as the browser asked for it */
  path: string
  state: JobState
  /** 'queued' only: place in line for an encoder (1 = next), once known */
  position?: number
  /** 'encoding' only: 0–1 of the clip written, once known */
  progress?: number
}

/** What a build reports while it runs; trackJob turns each into a job event */
export interface BuildHooks {
  /** Waiting for a free encoder, at this place in line (1 = next) */
  onQueued: (position: number) => void
  /** Got an encoder: ffmpeg starts */
  onEncoding: () => void
  /** 0–1 of the clip written */
  onProgress: (fraction: number) => void
}

/** Encoding progress is announced at most this often per preview (and only when the % changes) */
const PROGRESS_EVERY_MS = 250

// Kept on globalThis: when Vite reloads a server file this module runs again,
// and a new emitter would leave the browsers' open event streams behind.
const holder = globalThis as unknown as { __medJobEvents?: EventEmitter }
const bus = (holder.__medJobEvents ??= new EventEmitter().setMaxListeners(0))

export function emitJob(event: JobEvent) {
  bus.emit('job', event)
}

/** A cache was cleared: every open page hears the new shared cache version (server/cacheVersion.ts) */
export function emitCacheCleared(version: number) {
  bus.emit('cache', version)
}

/** Calls `listener` whenever a cache is cleared; returns a function that stops it */
export function onCacheCleared(listener: (version: number) => void): () => void {
  bus.on('cache', listener)
  return () => bus.off('cache', listener)
}

/** Calls `listener` for every job event; returns a function that stops it */
export function onJob(listener: (event: JobEvent) => void): () => void {
  bus.on('job', listener)
  return () => bus.off('job', listener)
}

/**
 * Runs `build` for one preview, announcing its progress: "queued" right away
 * (only if it isn't cached yet) and again with its place in line, "encoding"
 * once ffmpeg starts and again with how far along it is, then "done",
 * "failed", or "cancelled". `signal` aborts when cancelJobs is called for it.
 */
export async function trackJob(
  kind: JobKind,
  path: string,
  needsBuild: boolean,
  build: (hooks: BuildHooks, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const key = jobKey(kind, path)
  const controller = new AbortController()
  let controllers = running.get(key)
  if (!controllers) running.set(key, (controllers = new Set()))
  controllers.add(controller)

  let lastPosition: number | undefined
  let lastPercent = -1
  let lastProgressAt = 0
  const hooks: BuildHooks = {
    onQueued(position) {
      if (position === lastPosition) return
      lastPosition = position
      emitJob({ kind, path, state: 'queued', position })
    },
    onEncoding() {
      emitJob({ kind, path, state: 'encoding' })
    },
    onProgress(fraction) {
      const percent = Math.floor(fraction * 100)
      const now = Date.now()
      if (percent === lastPercent || now - lastProgressAt < PROGRESS_EVERY_MS) return
      lastPercent = percent
      lastProgressAt = now
      emitJob({ kind, path, state: 'encoding', progress: fraction })
    },
  }

  if (needsBuild) emitJob({ kind, path, state: 'queued' })
  try {
    await build(hooks, controller.signal)
  } catch (e) {
    // also when another request's build it was waiting on got cancelled
    emitJob({ kind, path, state: e instanceof JobCancelled ? 'cancelled' : 'failed' })
    throw e
  } finally {
    controllers.delete(controller)
    if (controllers.size === 0 && running.get(key) === controllers) running.delete(key)
  }
  if (needsBuild) emitJob({ kind, path, state: 'done' })
}

/**
 * For `?wait=0` requests of a preview that isn't built yet: starts the build
 * in the background (unless it's already running) and answers 202 at once,
 * so the browser doesn't keep one of its few connections to this server
 * (6 over HTTP/1.1) open for the whole encode. The page learns the outcome
 * from the job events and asks again. `out` is the file the build makes
 * (its `once` key); `start` runs it through trackJob.
 */
export function answerPending(
  res: ServerResponse,
  out: string,
  what: string,
  start: () => Promise<void>,
) {
  if (!isRunning(out)) {
    start().catch((e: unknown) => {
      // trackJob already announced "failed" / "cancelled"
      if (e instanceof JobCancelled) return
      console.error(`${what} failed: ${e instanceof Error ? e.message : e}`)
    })
  }
  sendJson(res, { pending: true }, 202)
}
