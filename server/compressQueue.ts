// The compress queue: videos and photos waiting to be compressed, compressed
// in the background by the server (./media/compress.ts, ./media/compressImage.ts)
// whatever the browser does meanwhile: other folders, a reload, the phone
// going to sleep, another device. Videos go one after another (each encode
// already keeps every core busy), photos on their own line beside them.
//
// Every open page hears each change on the job events stream
// (`event: compress`, server/handlers/jobEvents.ts) and can ask for the whole
// list (GET ROUTE_COMPRESS_JOBS). Ended jobs stay listed, with their outcome,
// until they're cleared.
//
// While anything is waiting or compressing, the idle shutdown is held off
// (./idle.ts keepAwake): the idle time is pushed back before it can run out,
// and only starts counting once the last one has ended.
//
// Each copy saved is marked new (./compressedNew.ts): its card shows the
// "Compressed!" banner until it's opened.
//
// Kept on globalThis: Vite reloads server files after an edit
// (server/vitePlugin.ts), and the running jobs must stay in the same list.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { markCompressedNew, setCompressedSeen } from './compressedNew.ts'
import { keepAwake, touchActivity } from './idle.ts'
import { emitCompress } from './jobEvents.ts'
import { isVideoName } from './listing.ts'
import { CompressError, compressVideo, discardCompressed } from './media/compress.ts'
import { compressImage, isCompressibleImageName } from './media/compressImage.ts'
import { resolveFile } from './paths.ts'

export type CompressJobState =
  /** In line: another compression is running */
  | 'waiting'
  | 'compressing'
  /** A copy was saved */
  | 'done'
  /** No copy saved (it would hardly shrink, HDR…): `note` says why */
  | 'skipped'
  | 'failed'
  /** Stopped before it ended; nothing was kept */
  | 'cancelled'
  /** A copy was saved, then deleted again */
  | 'discarded'

export interface CompressJob {
  id: string
  /** The original, inside the shared folder (as the listing shows it) */
  path: string
  name: string
  /** Its folder inside the shared folder ('' = the shared folder itself) */
  folder: string
  kind: 'video' | 'image'
  /** Seconds of video (from the listing, for the time left); null if unknown */
  duration: number | null
  state: CompressJobState
  /** 0–1 encoded (videos) */
  fraction: number
  /** × real time; null until known */
  speed: number | null
  /** Size of the original, once known */
  before: number | null
  /** Size of the copy (done only) */
  after: number | null
  /** The copy saved, inside the shared folder (done only) */
  copyPath: string | null
  copyName: string | null
  /** Why no copy was made, why it failed, or where the copy went */
  note: string
  /** When it was queued / ended (ms since 1970) */
  queuedAt: number
  endedAt: number | null
}

/** What a page asks to compress: a file, and its length if it's a video */
export interface CompressRequest {
  path: string
  duration?: number | null
}

interface QueueState {
  /** In the order they were queued */
  jobs: Map<string, CompressJob>
  /** Jobs still running or waiting, so they can be stopped */
  controllers: Map<string, AbortController>
}

const KEY = Symbol.for('med.compressQueue')
const store = globalThis as typeof globalThis & { [KEY]?: QueueState }
const state: QueueState = (store[KEY] ??= { jobs: new Map(), controllers: new Map() })

/** Ended jobs kept in the list at most; the oldest go first */
const MAX_ENDED = 500
/** A job's progress is announced at most this often */
const PROGRESS_EVERY_MS = 500

export function isActive(job: CompressJob): boolean {
  return job.state === 'waiting' || job.state === 'compressing'
}

// the server doesn't shut down when idle while anything is waiting or compressing
keepAwake('compress', () => [...state.jobs.values()].some(isActive))

function announce(job: CompressJob) {
  // a copy: the bus hands it to the streams later, and the job keeps changing
  emitCompress({ job: { ...job } })
}

/** Every job, oldest first */
export function compressJobs(): CompressJob[] {
  return [...state.jobs.values()]
}

/** Drops the oldest ended jobs past MAX_ENDED */
function prune() {
  const ended = compressJobs().filter((j) => !isActive(j))
  const extra = ended.length - MAX_ENDED
  if (extra <= 0) return
  const removed = ended.slice(0, extra).map((j) => j.id)
  for (const id of removed) state.jobs.delete(id)
  emitCompress({ removed })
}

/** Ends a job (once: a job stopped while waiting has already ended) */
function end(job: CompressJob, changes: Partial<CompressJob>) {
  if (job.endedAt !== null) return
  Object.assign(job, changes, { endedAt: Date.now(), speed: null })
  touchActivity()
  announce(job)
}

/**
 * Adds files to the queue; each starts as soon as its line is free. Files
 * that aren't videos or photos, are gone, or are already in the queue are
 * refused, with why.
 */
export async function enqueueCompress(
  requests: CompressRequest[],
): Promise<{ queued: CompressJob[]; refused: Array<{ path: string; error: string }> }> {
  const queued: CompressJob[] = []
  const refused: Array<{ path: string; error: string }> = []
  for (const request of requests) {
    const rel = request.path
    const file = await resolveFile(rel)
    if (!file) {
      refused.push({ path: rel, error: 'File not found' })
      continue
    }
    const name = path.posix.basename(rel)
    const isImage = isCompressibleImageName(name)
    if (!isImage && !isVideoName(name)) {
      refused.push({ path: rel, error: 'Only videos and photos can be compressed' })
      continue
    }
    if (compressJobs().some((j) => j.path === rel && isActive(j))) {
      refused.push({ path: rel, error: 'It is already in the queue' })
      continue
    }
    const folder = path.posix.dirname(rel)
    const duration = Number(request.duration)
    const job: CompressJob = {
      id: randomUUID(),
      path: rel,
      name,
      folder: folder === '.' ? '' : folder,
      kind: isImage ? 'image' : 'video',
      duration: !isImage && Number.isFinite(duration) && duration > 0 ? duration : null,
      state: 'waiting',
      fraction: 0,
      speed: null,
      before: null,
      after: null,
      copyPath: null,
      copyName: null,
      note: '',
      queuedAt: Date.now(),
      endedAt: null,
    }
    state.jobs.set(job.id, job)
    queued.push(job)
    announce(job)
    void run(job, file)
  }
  prune()
  return { queued, refused }
}

async function run(job: CompressJob, file: string) {
  const controller = new AbortController()
  state.controllers.set(job.id, controller)
  let lastAnnounced = 0
  try {
    const result = await (job.kind === 'image' ? compressImage : compressVideo)(file, {
      signal: controller.signal,
      onStart: () => {
        job.state = 'compressing'
        announce(job)
      },
      onProgress: (p) => {
        job.fraction = p.fraction
        job.speed = p.speed
        const now = Date.now()
        if (now - lastAnnounced < PROGRESS_EVERY_MS) return
        lastAnnounced = now
        announce(job)
      },
    })
    if (job.endedAt !== null) return
    if (result.compressed && result.name) {
      // by the path the listing shows (the original's folder as it was asked for)
      const copyPath = job.folder ? `${job.folder}/${result.name}` : result.name
      await markCompressedNew(copyPath).catch((e) =>
        console.error('Saving the new compressed copies failed:', e),
      )
      end(job, {
        state: 'done',
        fraction: 1,
        before: result.before,
        after: result.after,
        copyPath,
        copyName: result.name,
        note: `Saved as ${result.name}`,
      })
    } else {
      end(job, {
        state: 'skipped',
        fraction: 1,
        before: result.before,
        after: result.after,
        note: result.note ?? '',
      })
    }
  } catch (e) {
    if (controller.signal.aborted) {
      end(job, { state: 'cancelled' })
    } else {
      if (!(e instanceof CompressError)) console.error(`Compressing ${file} failed:`, e)
      end(job, {
        state: 'failed',
        note: e instanceof CompressError ? e.message : 'It could not be compressed',
      })
    }
  } finally {
    state.controllers.delete(job.id)
  }
}

/**
 * Stops jobs (`ids`), waiting or compressing: a running ffmpeg is killed and
 * nothing of it is kept; the copies already saved stay. Returns how many were stopped.
 */
export function cancelCompress(ids: Iterable<string>): number {
  let stopped = 0
  for (const id of ids) {
    const job = state.jobs.get(id)
    if (!job || !isActive(job)) continue
    state.controllers.get(id)?.abort()
    // still in line: it only notices once its turn comes, so it ends now
    if (job.state === 'waiting') end(job, { state: 'cancelled' })
    stopped++
  }
  return stopped
}

/** The ids of the jobs in `folder` (every job if undefined) */
export function jobIdsIn(folder?: string): string[] {
  return compressJobs()
    .filter((j) => folder === undefined || j.folder === folder)
    .map((j) => j.id)
}

/**
 * Deletes the copy a job saved, for good (the original stays). Only for
 * copies saved in the last COMPRESS_DISCARD_WINDOW_MS; throws a
 * CompressError otherwise.
 */
export async function discardCompressJob(id: string): Promise<CompressJob> {
  const job = state.jobs.get(id)
  if (!job || job.state !== 'done' || !job.copyPath) {
    throw new CompressError('Only copies that were just compressed can be discarded')
  }
  const file = await resolveFile(job.copyPath)
  if (!file) throw new CompressError('The copy is gone already (moved or deleted)')
  if (!(await discardCompressed(file))) {
    throw new CompressError('Only copies compressed in the last day can be discarded')
  }
  await setCompressedSeen(job.copyPath).catch(() => false)
  Object.assign(job, { state: 'discarded', after: null, note: '' })
  announce(job)
  return job
}

/** Removes the ended jobs of `folder` (all folders if undefined) from the list. Returns how many */
export function clearEndedCompress(folder?: string): number {
  const removed = compressJobs()
    .filter((j) => !isActive(j) && (folder === undefined || j.folder === folder))
    .map((j) => j.id)
  for (const id of removed) state.jobs.delete(id)
  if (removed.length) emitCompress({ removed })
  return removed.length
}
