import { reactive, watch } from 'vue'
import { API, PREVIEW_RECHECK_MS } from '@/constants'

/** Which kind of preview a server job builds (matches server/jobEvents.ts) */
export type JobKind = 'video' | 'folder'
/** 'cancelled': its card left the screen (on this or another device) before it was built */
export type JobState = 'queued' | 'encoding' | 'done' | 'failed' | 'cancelled'

/** The latest a server job said about itself */
export interface JobStatus {
  state: JobState
  /** 'queued' only: place in line for an encoder (1 = next), once known */
  position?: number
  /** 'encoding' only: 0–1 of the clip written, once known */
  progress?: number
}

interface JobEvent extends JobStatus {
  kind: JobKind
  path: string
}

// One stream for the whole app, shared by every card
const states = reactive(new Map<string, JobStatus>())
let stream: EventSource | null = null
let watchingTimings = false

function key(kind: JobKind, path: string): string {
  return `${kind}:${path}`
}

function connect() {
  if (stream) return

  // Previews detect browser-cache hits from the browser's list of finished
  // requests, which has a size limit: empty it when full instead of letting
  // new requests go unrecorded (once for the whole app, so it lives here)
  if (!watchingTimings) {
    watchingTimings = true
    performance.addEventListener('resourcetimingbufferfull', () =>
      performance.clearResourceTimings(),
    )
  }

  // reconnects by itself if the connection drops (e.g. the server reloads)
  stream = new EventSource(API.jobEvents)
  stream.onmessage = (message: MessageEvent<string>) => {
    try {
      const { kind, path, ...status } = JSON.parse(message.data) as JobEvent
      states.set(key(kind, path), status)
    } catch {
      // not a job event
    }
  }
}

/**
 * Closes the stream (the screen was locked: the server would refuse it
 * anyway). The next useJobEvents, after unlocking, opens a new one.
 */
export function disconnectJobEvents() {
  stream?.close()
  stream = null
  states.clear()
}

/**
 * Live state of the server's preview builds. The stream opens on first use;
 * call this early (App does) so events from the very first loads arrive.
 */
export function useJobEvents() {
  connect()

  /** What the server is doing for this preview (with its place in line or progress), if it said anything */
  function jobStatus(kind: JobKind, path: string): JobStatus | undefined {
    return states.get(key(kind, path))
  }

  /** Forget an old state before a new load, so it isn't shown again */
  function forgetJob(kind: JobKind, path: string) {
    states.delete(key(kind, path))
  }

  /**
   * Waits until the server says this preview is done or failed. Gives up with
   * 'recheck' after PREVIEW_RECHECK_MS, in case the event was missed (the
   * stream reconnected), so the caller asks the server again; also when the
   * build was cancelled (another device's card left the screen), so asking
   * again starts a new one. Rejects if `signal` aborts.
   */
  function waitForJob(
    kind: JobKind,
    path: string,
    signal: AbortSignal,
  ): Promise<'done' | 'failed' | 'recheck'> {
    return new Promise((resolve, reject) => {
      const k = key(kind, path)
      const outcome = (state: JobState | undefined) =>
        state === 'done' || state === 'failed'
          ? state
          : state === 'cancelled'
            ? 'recheck'
            : null
      const now = outcome(states.get(k)?.state)
      if (now) return resolve(now)
      if (signal.aborted) return reject(signal.reason)

      const stop = watch(
        () => states.get(k)?.state,
        (state) => {
          const result = outcome(state)
          if (!result) return
          cleanup()
          resolve(result)
        },
      )
      const timer = setTimeout(() => {
        cleanup()
        resolve('recheck')
      }, PREVIEW_RECHECK_MS)
      const onAbort = () => {
        cleanup()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort)
      function cleanup() {
        stop()
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    })
  }

  return { jobStatus, forgetJob, waitForJob }
}
