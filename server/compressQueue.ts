// The compress queue: videos and photos waiting to be compressed, compressed
// in the background by the server (./media/compress.ts, ./media/compressImage.ts)
// whatever the browser does meanwhile: other folders, a reload, the phone
// going to sleep, another device. Videos go one after another, photos on
// their own line beside them.
//
// The edit dialog's trimmed / cropped copies are made by it too
// (./media/editMedia.ts; `action: 'edit'`), on the same two lines, so an
// edit and a compression never encode at once. Everything below applies to
// them the same way: saved, resumed, stopped, discarded, cleared.
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
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isCompressedNew, markCompressedNew, setCompressedSeen } from './compressedNew.ts'
import { COMPRESS_QUEUE_FILE } from './consts/server.ts'
import { bumpCacheVersion } from './cacheVersion.ts'
import { moveFavorite } from './favorites.ts'
import { forgetHeatmap, moveHeatmaps } from './heatmap.ts'
import { hideCopy, unhideCopy } from './hiddenCopies.ts'
import { keepAwake, touchActivity } from './idle.ts'
import { emitCompress } from './jobEvents.ts'
import { isVideoName } from './listing.ts'
import {
  CompressError,
  compressVideo,
  discardCompressed,
  type CompressHooks,
} from './media/compress.ts'
import { compressImage, isCompressibleImageName } from './media/compressImage.ts'
import { MIN_LENGTH, type VideoEdit } from './media/edit.ts'
import { editMedia, isEditableName } from './media/editMedia.ts'
import { purgeVideo } from './media/purge.ts'
import { claimName } from './names.ts'
import { resolveDir, resolveFile } from './paths.ts'
import { movePlays } from './plays.ts'
import { onShutdown } from './shutdown.ts'
import { moveToTrash } from './trash.ts'
import { moveViewLog } from './viewLog.ts'
import { moveViews } from './views.ts'
import { moveWatchTime } from './watchTime.ts'

/** What a job makes: a compressed copy, or (the edit dialog) a trimmed / cropped one */
export type CompressAction = 'compress' | 'edit'

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
  action: CompressAction
  /** The edit to make (edits only): the part of the video kept, the crop */
  edit: VideoEdit | null
  /**
   * Edits only: the edited copy is compressed too, right after, in the same
   * job; `before` / `after` are then the original's size and the compressed
   * copy's, and only the compressed one is kept
   */
  compressAfter: boolean
  /**
   * The result takes the original's place instead of being saved beside it:
   * the original goes to the desktop's trash and the result gets its name
   * (its own extension: a video edit is always .mp4), keeping its heart,
   * views and plays. `copyPath` / `copyName` are then the file in its place
   */
  replace: boolean
  /** The original, inside the shared folder (as the listing shows it) */
  path: string
  name: string
  /** Its folder inside the shared folder ('' = the shared folder itself) */
  folder: string
  kind: 'video' | 'image'
  /**
   * Seconds of video encoded (from the listing, or the part an edit keeps),
   * for the time left; null if unknown
   */
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

/** What a page asks to compress: a file, its length if it's a video, and whether the result replaces it */
export interface CompressRequest {
  path: string
  duration?: number | null
  replace?: boolean
}

/**
 * Why `rel` can't get another job now (null: it can). A file being replaced
 * takes no other job (it would be trashed under it), and a file with a job
 * waiting or running can't be replaced until that's done. A file can't be
 * compressed twice at once; edits of it can stack
 */
function conflictOf(rel: string, action: CompressAction, replace: boolean): string | null {
  const active = compressJobs().filter((j) => j.path === rel && isActive(j))
  if (active.some((j) => j.replace)) return 'It is being replaced: wait until that is done'
  if (replace && active.length > 0) {
    return 'It is already in the queue: it can be replaced once that is done'
  }
  if (action === 'compress' && active.some((j) => j.action === 'compress')) {
    return 'It is already in the queue'
  }
  return null
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
/** The hidden file an encode writes to before it gets its name (./media/compress.ts, compressImage.ts, edit.ts…) */
const LEFTOVER = /^\.[0-9a-f-]{36}\.med-(compress|edit)/

export function isActive(job: CompressJob): boolean {
  return job.state === 'waiting' || job.state === 'compressing'
}

// ── Saving ──

/** A whole edit: every number there, and finite */
function isEdit(value: unknown): value is VideoEdit {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (['start', 'end', 'x', 'y', 'w', 'h'] as const).every(
    (key) => typeof e[key] === 'number' && Number.isFinite(e[key]),
  )
}

/** A saved job (lists saved before edits were queued have no `action`: compressions) */
function isJob(
  value: unknown,
): value is Partial<CompressJob> &
  Omit<CompressJob, 'action' | 'edit' | 'compressAfter' | 'replace'> {
  const j = value as Partial<CompressJob> | null
  return (
    !!j &&
    typeof j.id === 'string' &&
    typeof j.path === 'string' &&
    typeof j.name === 'string' &&
    typeof j.folder === 'string' &&
    (j.kind === 'video' || j.kind === 'image') &&
    typeof j.state === 'string' &&
    typeof j.queuedAt === 'number' &&
    (j.action === undefined || j.action === 'compress' || (j.action === 'edit' && isEdit(j.edit)))
  )
}

/** The saved list (none, or unreadable: empty) */
function loadJobs(): Map<string, CompressJob> {
  const jobs = new Map<string, CompressJob>()
  try {
    const saved: unknown = JSON.parse(readFileSync(COMPRESS_QUEUE_FILE, 'utf8'))
    if (Array.isArray(saved)) {
      for (const job of saved) {
        if (!isJob(job)) continue
        const action = job.action ?? 'compress'
        jobs.set(job.id, {
          ...job,
          action,
          edit: action === 'edit' ? job.edit! : null,
          compressAfter: action === 'edit' && job.compressAfter === true,
          replace: job.replace === true,
          speed: null,
        })
      }
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
  // an edited copy kept out of the listings while it was compressed: it's the
  // result (it wouldn't compress, or the job failed) or gone, so it shows again
  if (job.action === 'edit') unhideCopy(job.copyPath)
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
    const replace = request.replace === true
    const conflict = conflictOf(rel, 'compress', replace)
    if (conflict) {
      refused.push({ path: rel, error: conflict })
      continue
    }
    const duration = Number(request.duration)
    const job = newJob(rel, 'compress', isImage ? 'image' : 'video', null, duration, false, replace)
    queued.push(job)
    start(job, file)
  }
  prune()
  if (queued.length) save()
  return { queued, refused }
}

/**
 * Adds an edited copy of `rel` to make (the edit dialog's trim / crop), which
 * starts as soon as its line is free. The same file can be in the queue
 * several times, each with its own edit. With `compressAfter`, the edited
 * copy is compressed too, in the same job. With `replace`, the result takes
 * the original's place (see CompressJob). Throws a CompressError saying why it
 * can't be.
 */
export async function enqueueEdit(
  rel: string,
  edit: unknown,
  compressAfter = false,
  replace = false,
): Promise<CompressJob> {
  if (!isEdit(edit)) throw new CompressError('Invalid edit')
  const file = await resolveFile(rel)
  if (!file) throw new CompressError('File not found')
  const name = path.posix.basename(rel)
  if (!isEditableName(name)) throw new CompressError('Only videos and photos can be edited')
  const conflict = conflictOf(rel, 'edit', replace)
  if (conflict) throw new CompressError(conflict)
  const isVideo = isVideoName(name)
  if (isVideo && edit.end - edit.start < MIN_LENGTH) {
    throw new CompressError('The part to keep is too short')
  }
  // only the edit's own numbers are kept (and saved); photos have nothing to trim
  const { x, y, w, h } = edit
  const kept: VideoEdit = isVideo
    ? { start: edit.start, end: edit.end, x, y, w, h }
    : { start: 0, end: 0, x, y, w, h }
  const job = newJob(
    rel,
    'edit',
    isVideo ? 'video' : 'image',
    kept,
    kept.end - kept.start,
    compressAfter,
    replace,
  )
  start(job, file)
  prune()
  save()
  return job
}

/** A new job, waiting; `duration`: seconds of video it encodes (anything else: unknown) */
function newJob(
  rel: string,
  action: CompressAction,
  kind: CompressJob['kind'],
  edit: VideoEdit | null,
  duration: number,
  compressAfter = false,
  replace = false,
): CompressJob {
  const folder = path.posix.dirname(rel)
  return {
    id: randomUUID(),
    action,
    edit,
    compressAfter,
    replace,
    path: rel,
    name: path.posix.basename(rel),
    folder: folder === '.' ? '' : folder,
    kind,
    duration: kind === 'video' && Number.isFinite(duration) && duration > 0 ? duration : null,
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
}

/** Lists a new job and gets it in line */
function start(job: CompressJob, file: string) {
  state.jobs.set(job.id, job)
  announce(job)
  void run(job, file)
}

/** The hooks of one of a job's two steps (edit, then compress): its progress fills `from` to `from + 0.5` */
function halfOf(hooks: CompressHooks, from: number): CompressHooks {
  return {
    ...hooks,
    onProgress: (p) => hooks.onProgress({ ...p, fraction: from + p.fraction / 2 }),
  }
}

/** Deletes the edited copy an edit + compress job made on the way (the compressed one replaced it, or it was stopped) */
async function dropEditedStep(job: CompressJob) {
  if (!job.copyPath) return
  const edited = await resolveFile(job.copyPath)
  // the job vouches for when it was made (also across a restart)
  if (edited) await discardCompressed(edited, job.queuedAt).catch(() => false)
}

/** A job's file in its folder, by the path the listing shows (the original's folder as it was asked for) */
function relIn(job: CompressJob, name: string): string {
  return job.folder ? `${job.folder}/${name}` : name
}

/**
 * Puts the finished file `name` (in the original's folder, kept out of the
 * listings) in place of the original `file`. The original goes to the
 * desktop's trash (restorable from the file manager), with its cached still /
 * preview / storyboard; the file takes its name, with its own extension (a
 * video edit is always .mp4: "clip.mov" → "clip.mp4"; if that's another
 * file's name, "clip (2).mp4"). What's kept for the original by its path
 * (heart, views, plays, time watched, view log, heatmap) follows it if the
 * name changed; a video trimmed at its start loses its heatmap (its times no
 * longer match). Answers the name it got. Throws a CompressError saying what
 * happened if it couldn't
 */
async function replaceOriginal(job: CompressJob, file: string, name: string): Promise<string> {
  const dir = path.dirname(file)
  // the cache names are worked out from the file, so do this while it's still there
  if (job.kind === 'video') await purgeVideo(file).catch(() => 0)
  try {
    await moveToTrash(file)
  } catch (e) {
    console.error(`Moving ${file} to the trash failed:`, e)
    throw new CompressError(`The original couldn't be moved to the trash, so it was kept: saved as ${name}`)
  }
  const base = path.basename(job.name, path.extname(job.name))
  let placed: string
  try {
    placed = await claimName(path.join(dir, name), dir, `${base}${path.extname(name)}`)
  } catch (e) {
    console.error(`Renaming ${name} to take ${file}'s place failed:`, e)
    throw new CompressError(
      `The original is in the trash, but the new file couldn't take its name: saved as ${name}`,
    )
  }
  const finalName = path.basename(placed)
  const finalRel = relIn(job, finalName)
  if (finalRel !== job.path) {
    const moves: Array<[string, string]> = [[job.path, finalRel]]
    const log = (what: string) => (e: unknown) => console.error(`Updating the ${what} failed:`, e)
    await moveFavorite(job.path, finalRel).catch(log('favorites'))
    await moveViews(moves).catch(log('views'))
    await movePlays(moves).catch(log('play counts'))
    await moveWatchTime(moves).catch(log('time watched'))
    await moveViewLog(moves).catch(log('view log'))
    await moveHeatmaps(moves).catch(log('heatmaps'))
    // the original's own badge, if it had one, went with it
    await setCompressedSeen(job.path).catch(() => false)
  }
  if (job.action === 'edit' && job.kind === 'video' && (job.edit?.start ?? 0) > 0.05) {
    await forgetHeatmap(finalRel).catch(() => {})
  }
  // the same path as the original: browsers would keep showing its still and
  // preview (they keep them by path for a while), so every device is told to
  // load them again, as when a cache is cleared
  if (finalRel === job.path) {
    await bumpCacheVersion().catch((e) => console.error('Bumping the cache version failed:', e))
  }
  console.log(`Replaced ${file} with ${placed} (the original is in the trash)`)
  return finalName
}

async function run(job: CompressJob, file: string) {
  const controller = new AbortController()
  state.controllers.set(job.id, controller)
  let lastAnnounced = 0
  const hooks: CompressHooks = {
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
  }
  /**
   * Keeps a step's file out of the listings from before it exists (claimName's
   * `hold`): an edited copy that is compressed next, or a result that will
   * replace its original
   */
  const hold = (name: string, held: boolean) => {
    if (held) hideCopy(relIn(job, name))
    else unhideCopy(relIn(job, name))
  }
  /**
   * The result `name` is saved: with `replace`, it takes the original's place
   * (kept as a copy if it can't, saying why); either way it gets its badges
   * (`kind`: what was done to it, and whether it replaced the original or is
   * a copy) until it's opened, and shows in the listings
   */
  const finish = async (name: string, kind: { edited: boolean; compressed: boolean }) => {
    let finalName = name
    let note = `Saved as ${name}`
    /** It took the original's place (not when that failed: then it's a copy) */
    let replaced = false
    if (job.replace) {
      try {
        finalName = await replaceOriginal(job, file, name)
        replaced = true
        note = finalName === job.name ? 'Replaced the original' : `Replaced the original, now ${finalName}`
      } catch (e) {
        note = e instanceof CompressError ? e.message : `The original couldn't be replaced: saved as ${name}`
      }
    }
    const copyPath = relIn(job, finalName)
    await markCompressedNew(copyPath, { ...kind, replaced }).catch((e) =>
      console.error('Saving the new compressed copies failed:', e),
    )
    // held while it was a step (or under its temporary name): it's the result now
    unhideCopy(relIn(job, name))
    return { copyPath, copyName: finalName, note }
  }
  try {
    if (job.action === 'edit' && job.edit) {
      // made already (the server stopped while it was being compressed): not again
      let edited = job.compressAfter && job.copyPath ? await resolveFile(job.copyPath) : null
      if (edited) {
        job.fraction = 0.5
        // after a restart: the edited copy stays out of the gallery until the compression ends
        hideCopy(job.copyPath!)
      } else {
        // an edit that is compressed next, or replaces the original: its edited
        // copy is kept out of the listings from the moment the file exists (its
        // name is held before it's linked), so the gallery never shows the step
        // in between
        const made = await editMedia(
          file,
          job.edit,
          job.compressAfter ? halfOf(hooks, 0) : hooks,
          job.compressAfter || job.replace ? hold : undefined,
        )
        if (job.endedAt !== null || state.shuttingDown) return
        if (!job.compressAfter) {
          end(job, {
            state: 'done',
            fraction: 1,
            ...(await finish(made.name, { edited: true, compressed: false })),
          })
          return
        }
        // saved, so a restart goes on from the compression
        job.copyPath = job.folder ? `${job.folder}/${made.name}` : made.name
        job.copyName = made.name
        // half done (photos report no progress of their own)
        job.fraction = 0.5
        announce(job)
        save()
        edited = await resolveFile(job.copyPath)
        if (!edited) throw new CompressError('The edited copy is gone (moved or deleted)')
      }
      const result = await (job.kind === 'image' ? compressImage : compressVideo)(edited, {
        ...halfOf(hooks, 0.5),
        // replacing: the compressed copy is a step too until it's in place
        hold: job.replace ? hold : undefined,
      })
      if (job.endedAt !== null || state.shuttingDown) return
      // "before" is the original's size, not the edited copy's (which was only a
      // step): the saving shown is what the trim / crop and the compression saved
      // together. The original gone meanwhile: the edited copy's, as the best known
      const originalSize = await stat(file).then(
        (s) => s.size,
        () => result.before,
      )
      if (result.compressed && result.name) {
        // only the compressed one is kept: the edited copy was a step towards it
        await dropEditedStep(job)
        end(job, {
          state: 'done',
          fraction: 1,
          before: originalSize,
          after: result.after,
          ...(await finish(result.name, { edited: true, compressed: true })),
        })
      } else {
        // it wouldn't get smaller: the edited copy is the result
        const name = job.copyName ?? path.posix.basename(job.copyPath ?? '')
        const done = await finish(name, { edited: true, compressed: false })
        end(job, {
          state: 'done',
          fraction: 1,
          before: originalSize,
          ...done,
          note: `${done.note}, not compressed: ${result.note ?? 'it would hardly get smaller'}`,
        })
      }
      return
    }
    const result = await (job.kind === 'image' ? compressImage : compressVideo)(file, {
      ...hooks,
      // replacing: the compressed copy is kept out of the listings until it's in place
      hold: job.replace ? hold : undefined,
    })
    if (job.endedAt !== null || state.shuttingDown) return
    if (result.compressed && result.name) {
      end(job, {
        state: 'done',
        fraction: 1,
        before: result.before,
        after: result.after,
        ...(await finish(result.name, { edited: false, compressed: true })),
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
      // stopped between the two steps (or during the second): the edited copy isn't kept either
      if (job.action === 'edit' && job.compressAfter && !state.shuttingDown) {
        await dropEditedStep(job)
      }
      end(job, { state: 'cancelled', copyPath: null, copyName: null })
    } else {
      const what = job.action === 'edit' ? 'edited' : 'compressed'
      if (!(e instanceof CompressError)) console.error(`${file} could not be ${what}:`, e)
      end(job, {
        state: 'failed',
        note: e instanceof CompressError ? e.message : `It could not be ${what}`,
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
    throw new CompressError('Only copies that were just compressed or edited can be discarded')
  }
  const file = await resolveFile(job.copyPath)
  if (!file) throw new CompressError('The copy is gone already (moved or deleted)')
  // the job itself is the proof this file is a copy it saved (and when)
  if (!(await discardCompressed(file, job.endedAt ?? undefined))) {
    throw new CompressError(
      'Only copies made in the last day can be discarded here: move it to the trash instead',
    )
  }
  await setCompressedSeen(job.copyPath).catch(() => false)
  Object.assign(job, { state: 'discarded', after: null, note: '' })
  announce(job)
  save()
  return job
}

/**
 * The copy `rel` was just opened in the viewer (its "Compressed!" / "Edited!"
 * badge gone). If it's one the list saved, nothing is waiting or running any
 * more, and every copy the list saved has been opened, the list is cleared,
 * like "Clear ended" (ended jobs without a copy go too): the top bar's button
 * goes away on every device. Returns how many jobs were removed
 */
export function clearIfAllSeen(rel: string): number {
  const jobs = compressJobs()
  if (jobs.some(isActive)) return 0
  const copies = jobs.filter((j) => j.state === 'done' && j.copyPath)
  if (!copies.some((j) => j.copyPath === rel)) return 0
  if (copies.some((j) => isCompressedNew(j.copyPath!))) return 0
  return clearEndedCompress()
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
