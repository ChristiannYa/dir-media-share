// The compress queue: videos and photos waiting to be compressed, compressed
// in the background by the server (./media/compress.ts, ./media/compressImage.ts)
// whatever the browser does meanwhile: other folders, a reload, the phone
// going to sleep, another device. Videos go one after another, photos on
// their own line beside them.
//
// Every open page hears each change on the job events stream
// (`event: compress`, server/handlers/jobEvents.ts) and can ask for the whole
// list (GET ROUTE_COMPRESS_JOBS). Ended jobs stay listed, with their outcome,
// until they're cleared.
//
// Saved in COMPRESS_QUEUE_FILE on every change of state (not on progress), so
// a restart loses nothing: the list, ended jobs included, is there again, and
// the jobs that hadn't ended (the server stopped: shut down by hand, idle,
// crashed, the laptop's power) start again by themselves, in the same order.
// One that was compressing starts over from the beginning (an encode can't be
// picked up halfway); the half-written file it left is deleted.
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
import { readFileSync } from 'node:fs'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { markCompressedNew, setCompressedSeen } from './compressedNew.ts'
import { COMPRESS_QUEUE_FILE } from './consts/server.ts'
import { keepAwake, touchActivity } from './idle.ts'
import { emitCompress } from './jobEvents.ts'
import { isVideoName } from './listing.ts'
import { CompressError, compressVideo, discardCompressed } from './media/compress.ts'
import { compressImage, isCompressibleImageName } from './media/compressImage.ts'
import { resolveDir, resolveFile } from './paths.ts'
import { onShutdown } from './shutdown.ts'

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
  /** Saves run one after another, so an older list can't overwrite a newer one */
  saving: Promise<void>
  /**
   * The server is stopping: the running encodes are killed, but their jobs
   * stay as they were saved (waiting / compressing), to start again next time
   */
  shuttingDown: boolean
}

const KEY = Symbol.for('med.compressQueue')
const store = globalThis as typeof globalThis & { [KEY]?: QueueState }
/** First load in this process: the saved list is read, and the jobs that hadn't ended start again */
const firstLoad = store[KEY] === undefined
const state: QueueState = (store[KEY] ??= {
  jobs: loadJobs(),
  controllers: new Map(),
  saving: Promise.resolve(),
  shuttingDown: false,
})
// a state made by an older version of this file has none of these yet
state.saving ??= Promise.resolve()
state.shuttingDown ??= false

/** Ended jobs kept in the list at most; the oldest go first */
const MAX_ENDED = 500
/** A job's progress is announced at most this often */
const PROGRESS_EVERY_MS = 500
/** The hidden file an encode writes to before it gets its name (./media/compress.ts, compressImage.ts) */
const LEFTOVER = /^\.[0-9a-f-]{36}\.med-compress/

export function isActive(job: CompressJob): boolean {
  return job.state === 'waiting' || job.state === 'compressing'
}

// ── Saving ──

function isJob(value: unknown): value is CompressJob {
  const j = value as Partial<CompressJob> | null
  return (
    !!j &&
    typeof j.id === 'string' &&
    typeof j.path === 'string' &&
    typeof j.name === 'string' &&
    typeof j.folder === 'string' &&
    (j.kind === 'video' || j.kind === 'image') &&
    typeof j.state === 'string' &&
    typeof j.queuedAt === 'number'
  )
}

/** The saved list (none, or unreadable: empty) */
function loadJobs(): Map<string, CompressJob> {
  const jobs = new Map<string, CompressJob>()
  try {
    const saved: unknown = JSON.parse(readFileSync(COMPRESS_QUEUE_FILE, 'utf8'))
    if (Array.isArray(saved)) {
      for (const job of saved) if (isJob(job)) jobs.set(job.id, { ...job, speed: null })
    }
  } catch {
    // no file yet
  }
  return jobs
}

/** Saves the list as it is now (not while stopping: the saved one must keep the jobs to resume) */
function save() {
  if (state.shuttingDown) return
  const text = JSON.stringify(compressJobs(), null, 2) + '\n'
  state.saving = state.saving
    .then(async () => {
      // a temp file, then rename: a crash mid-write can't leave half a file
      await mkdir(path.dirname(COMPRESS_QUEUE_FILE), { recursive: true })
      const tmp = `${COMPRESS_QUEUE_FILE}.tmp`
      await writeFile(tmp, text)
      await rename(tmp, COMPRESS_QUEUE_FILE)
    })
    .catch((e) => console.error('Saving the compress queue failed:', e))
}

// ── Staying up, stopping ──

// the server doesn't shut down when idle while anything is waiting or compressing
keepAwake('compress', () => [...state.jobs.values()].some(isActive))

/**
 * Stopping the server: kill the running encodes (they'd go on without it),
 * leaving their jobs saved as they are, to start again on the next start
 */
function stopForShutdown() {
  state.shuttingDown = true
  for (const controller of state.controllers.values()) controller.abort()
}
onShutdown('compress', stopForShutdown)
// any other way out of the process (an error, process.exit elsewhere); once per process
const EXIT_KEY = Symbol.for('med.compressQueueExit')
const exitStore = globalThis as typeof globalThis & { [EXIT_KEY]?: boolean }
if (!exitStore[EXIT_KEY]) {
  exitStore[EXIT_KEY] = true
  process.once('exit', () => stopForShutdown())
}

// ── The list ──

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

/** Ends a job (once: a job stopped while waiting has already ended). Not while stopping */
function end(job: CompressJob, changes: Partial<CompressJob>) {
  if (job.endedAt !== null || state.shuttingDown) return
  Object.assign(job, changes, { endedAt: Date.now(), speed: null })
  touchActivity()
  announce(job)
  save()
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
  if (queued.length) save()
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
        save()
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
    if (job.endedAt !== null || state.shuttingDown) return
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

// ── Starting again after a restart ──

/** Deletes the half-written files encodes left in `folders` when the server stopped under them */
async function removeLeftovers(folders: Set<string>) {
  for (const folder of folders) {
    const dir = await resolveDir(folder)
    if (!dir) continue
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!LEFTOVER.test(name)) continue
      await unlink(path.join(dir, name)).then(
        () => console.log(`Deleted a half-compressed leftover: ${path.join(dir, name)}`),
        () => {},
      )
    }
  }
}

/**
 * The server just started with jobs that hadn't ended: each starts again, in
 * the order they had (the one that was compressing first). A file that's
 * gone meanwhile fails, saying so
 */
async function resumeInterrupted() {
  // nothing runs yet in this process, so any leftover is from before
  await removeLeftovers(new Set(compressJobs().map((j) => j.folder)))
  const interrupted = compressJobs()
    .filter(isActive)
    .sort(
      (a, b) =>
        Number(b.state === 'compressing') - Number(a.state === 'compressing') ||
        a.queuedAt - b.queuedAt,
    )
  if (interrupted.length === 0) return
  console.log(`Compress queue: starting the ${interrupted.length} unfinished again`)
  for (const job of interrupted) {
    const wasRunning = job.state === 'compressing'
    Object.assign(job, {
      state: 'waiting',
      fraction: 0,
      speed: null,
      note: wasRunning ? 'Started over: the server stopped while it was compressing' : '',
    })
    const file = await resolveFile(job.path)
    if (!file) {
      end(job, { state: 'failed', note: 'File not found: moved or deleted while the server was off' })
      continue
    }
    announce(job)
    void run(job, file)
  }
  save()
}

// after this file has run to the end (everything above is defined by then)
if (firstLoad) {
  setImmediate(() => {
    resumeInterrupted().catch((e) => console.error('Resuming the compress queue failed:', e))
  })
}

// ── Stopping, discarding, clearing ──

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
 * copies saved in the last COMPRESS_DISCARD_WINDOW_MS, also across a restart
 * (the saved list says when); throws a CompressError otherwise.
 */
export async function discardCompressJob(id: string): Promise<CompressJob> {
  const job = state.jobs.get(id)
  if (!job || job.state !== 'done' || !job.copyPath) {
    throw new CompressError('Only copies that were just compressed can be discarded')
  }
  const file = await resolveFile(job.copyPath)
  if (!file) throw new CompressError('The copy is gone already (moved or deleted)')
  // the job itself is the proof this file is a copy it saved (and when)
  if (!(await discardCompressed(file, job.endedAt ?? undefined))) {
    throw new CompressError(
      'Only copies compressed in the last day can be discarded here: move it to the trash instead',
    )
  }
  await setCompressedSeen(job.copyPath).catch(() => false)
  Object.assign(job, { state: 'discarded', after: null, note: '' })
  announce(job)
  save()
  return job
}

/** Removes the ended jobs of `folder` (all folders if undefined) from the list. Returns how many */
export function clearEndedCompress(folder?: string): number {
  const removed = compressJobs()
    .filter((j) => !isActive(j) && (folder === undefined || j.folder === folder))
    .map((j) => j.id)
  for (const id of removed) state.jobs.delete(id)
  if (removed.length) {
    emitCompress({ removed })
    save()
  }
  return removed.length
}
