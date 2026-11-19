import { ref } from 'vue'
import { API, CACHE_VERSION_STORAGE_KEY, FILES_PREFIX } from '@/constants'
import type { FieldGroup } from '@/settings'
import type { CompressJob, Entry, FolderRef, ServerInfo, Storyboard } from '@/types'

// ── Cache version ──

function readCacheVersion(): number {
  try {
    return Number(localStorage.getItem(CACHE_VERSION_STORAGE_KEY)) || 0
  } catch {
    return 0
  }
}

/**
 * Goes up whenever a cache is cleared. Still-image URLs include it, so the
 * browser fetches fresh copies instead of reusing its own. Reactive, so
 * cards on screen re-render with the new URLs.
 */
export const cacheVersion = ref(readCacheVersion())

export function bumpCacheVersion() {
  cacheVersion.value++
  try {
    localStorage.setItem(CACHE_VERSION_STORAGE_KEY, String(cacheVersion.value))
  } catch {
    // storage unavailable (private window): the bump still lasts until reload
  }
}

/**
 * Goes up when the server's preview settings change. Previews on screen are
 * keyed by it, so they load again (getting clips made with the new settings)
 * instead of playing their old clip until the page is reloaded.
 */
export const previewGeneration = ref(0)

/**
 * The cache version shared by every device (server/cacheVersion.ts): goes up
 * when a cache is cleared on any device. Still-image URLs include it next to
 * this device's own cacheVersion, so every browser drops its cached copies.
 * From /api/info on load, then from the job events stream
 */
export const sharedCacheVersion = ref<number | null>(null)

/**
 * The server's shared cache version is `version`. A new one (a cache was
 * cleared, here or on another device) also makes the previews on screen load
 * again, getting the rebuilt clips. Not on the first one heard: nothing is
 * on screen to refresh yet
 */
export function setSharedCacheVersion(version: number) {
  const before = sharedCacheVersion.value
  if (version === before) return
  sharedCacheVersion.value = version
  if (before !== null) previewGeneration.value++
}

/** `v=` of still-image URLs: the shared version and this device's own */
function stillVersion(): string {
  return `${sharedCacheVersion.value ?? 0}.${cacheVersion.value}`
}

// ── Login ──

/** Logged in?, ms until it locks by itself (null = never), and the passcode's length */
export interface SessionInfo {
  unlocked: boolean
  remainingMs: number | null
  /** Digits in the passcode; null if it isn't set */
  passcodeLength: number | null
}

export async function fetchSession(): Promise<SessionInfo> {
  const res = await fetch(API.session)
  if (!res.ok) throw new Error(`Checking the login failed (${res.status})`)
  return (await res.json()) as SessionInfo
}

/**
 * ok, with ms until it locks by itself (null = never); or how many ms until
 * the next try is allowed (0 = right away)
 */
export type LoginResult =
  | { ok: true; remainingMs: number | null }
  | { ok: false; retryAfter: number }

export async function login(passcode: string): Promise<LoginResult> {
  const res = await fetch(API.login, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  })
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { remainingMs?: number | null }
    return { ok: true, remainingMs: data.remainingMs ?? null }
  }
  const data = (await res.json().catch(() => ({}))) as { retryAfter?: number }
  return { ok: false, retryAfter: data.retryAfter ?? 0 }
}

/** Forgets the login on this browser (other devices stay logged in) */
export async function logout(): Promise<void> {
  const res = await fetch(API.logout, { method: 'POST' })
  if (!res.ok) throw new Error(`Locking failed (${res.status})`)
}

// ── Requests ──

export async function fetchInfo(): Promise<ServerInfo> {
  const res = await fetch(API.info)
  return (await res.json()) as ServerInfo
}

export async function fetchEntries(path: string): Promise<Entry[]> {
  const res = await fetch(`${API.browse}?path=${encodeURIComponent(path)}`)
  return (await res.json()) as Entry[]
}

/** Layout of a video's storyboard (see `storyboardUrl`); null if it can't be built */
export async function fetchStoryboard(url: string, signal?: AbortSignal): Promise<Storyboard | null> {
  const res = await fetch(url, { signal })
  if (!res.ok) return null
  return (await res.json()) as Storyboard
}

/**
 * Deletes the cached stills, previews and storyboards under a folder, on the
 * server; every device then fetches fresh ones. Returns how many files
 */
export async function clearCache(path: string): Promise<number> {
  return postClearCache(`?path=${encodeURIComponent(path)}`)
}

/** Empties the server's whole cache (every folder); every device then fetches fresh copies. Returns how many files */
export async function clearAllCaches(): Promise<number> {
  return postClearCache('?all=1')
}

async function postClearCache(query: string): Promise<number> {
  const res = await fetch(`${API.clearCache}${query}`, { method: 'POST' })
  if (!res.ok) throw new Error(`Clearing the cache failed (${res.status})`)
  const data = (await res.json()) as { removed: number; version?: number }
  // right away here; the other devices hear it on the job events stream
  if (typeof data.version === 'number') setSharedCacheVersion(data.version)
  return data.removed
}

/** Sends a POST; throws with the server's `error` message if it fails */
async function post<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'POST' })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

/** Answer of /api/preview and /api/folder-preview */
export interface PreviewInfo {
  /** Where to download the clip */
  url: string
  /** True if the server encoded it for this request, false if it was already cached there */
  built: boolean
  /** The clip's frame rate (null if unknown), to pick a speed that fits the screen */
  fps: number | null
  /**
   * Video previews only: the clip is the whole video (a short one, no longer
   * than all the slices together), not slices of it. Measured on the clip
   */
  whole?: boolean
}

/**
 * Asks the server for a preview clip (`url` from previewUrl / folderPreviewUrl).
 * Returns null if it isn't built yet: the server starts building it and
 * announces the outcome on the job events (see useJobEvents' waitForJob),
 * so the request doesn't hold one of the browser's few connections meanwhile.
 */
export async function fetchPreviewInfo(url: string, signal?: AbortSignal): Promise<PreviewInfo | null> {
  const res = await fetch(`${url}&wait=0`, { signal })
  if (res.status === 202) return null
  if (!res.ok) throw new Error(`Preview failed (${res.status})`)
  return (await res.json()) as PreviewInfo
}

/**
 * Tells the server to stop building a preview (queued or encoding): its card
 * left the screen. `keepalive`, so it's still sent while the page navigates
 * away. Fails quietly: the build then just finishes.
 */
export function cancelPreviewJob(kind: 'video' | 'folder', path: string): void {
  void fetch(`${API.cancelJob}?kind=${kind}&path=${encodeURIComponent(path)}`, {
    method: 'POST',
    keepalive: true,
  }).catch(() => {})
}

/** Subfolders of a folder (names and paths only, fast) */
export async function fetchFolders(path: string): Promise<FolderRef[]> {
  const res = await fetch(`${API.folders}?path=${encodeURIComponent(path)}`)
  return (await res.json()) as FolderRef[]
}

/** One line of the fix-ts answer (see server/handlers/tsFix.ts) */
type JobMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; path: string; name: string }
  | { type: 'error'; error: string }

/**
 * Has the server remux an MPEG-TS video into a playable MP4 saved next to it
 * as "<name>_ts_fix.mp4" (the original is kept). `onProgress` hears 0–1 of it
 * written; resolves with the copy once it's saved.
 */
export async function fixTs(
  path: string,
  onProgress: (fraction: number) => void,
): Promise<{ path: string; name: string }> {
  const res = await fetch(`${API.fixTs}?path=${encodeURIComponent(path)}`, { method: 'POST' })
  return readJob(res, onProgress, 'Fixing')
}

/** Reads a progress… / done / error stream of JSON lines until its outcome */
async function readJob(
  res: Response,
  onProgress: (fraction: number) => void,
  what: string,
): Promise<{ path: string; name: string }> {
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `${what} failed (${res.status})`)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const message = JSON.parse(line) as JobMessage
      if (message.type === 'progress') onProgress(message.fraction)
      else if (message.type === 'done') return { path: message.path, name: message.name }
      else throw new Error(message.error)
    }
  }
  // the stream ended without an outcome (server restarted, connection cut)
  throw new Error('Connection lost')
}

/** Moves a file to the computer's trash (restorable from the file manager) */
export async function trashFile(path: string): Promise<void> {
  await post(`${API.trashFile}?path=${encodeURIComponent(path)}`)
}

/** Moves a file into the folder `to`; returns its new path */
export async function moveFile(path: string, to: string): Promise<string> {
  const data = await post<{ path: string }>(
    `${API.moveFile}?path=${encodeURIComponent(path)}&to=${encodeURIComponent(to)}`,
  )
  return data.path
}

/** Answer of GET /api/settings */
export interface ServerSettingsInfo {
  values: Record<string, unknown>
  defaults: Record<string, unknown>
  groups: FieldGroup[]
}

export async function fetchServerSettings(): Promise<ServerSettingsInfo> {
  const res = await fetch(API.settings)
  if (!res.ok) throw new Error(`Loading the server settings failed (${res.status})`)
  return (await res.json()) as ServerSettingsInfo
}

/** Thrown by saveServerSettings; `problems` maps keys to what's wrong with their value */
export class SettingsRejected extends Error {
  readonly problems: Record<string, string>

  constructor(message: string, problems: Record<string, string>) {
    super(message)
    this.problems = problems
  }
}

/** Saves changed server settings (all or nothing); returns every current value */
export async function saveServerSettings(
  changes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(API.settings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  })
  const data = (await res.json().catch(() => ({}))) as {
    values?: Record<string, unknown>
    error?: string
    problems?: Record<string, string>
  }
  if (!res.ok || !data.values) {
    throw new SettingsRejected(data.error ?? `Saving failed (${res.status})`, data.problems ?? {})
  }
  return data.values
}

/** Creates an empty folder `name` inside `dir`; returns its path */
export async function createFolder(dir: string, name: string): Promise<string> {
  const data = await post<{ path: string }>(
    `${API.createFolder}?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`,
  )
  return data.path
}

/** Renames a file or folder where it is; returns its new path */
export async function renameEntry(path: string, name: string): Promise<string> {
  const data = await post<{ path: string }>(
    `${API.rename}?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
  )
  return data.path
}

/**
 * Renames the photos and videos directly in a folder to <folder>_1, _2… from
 * the oldest; returns how many got a new name
 */
export async function numberFiles(path: string): Promise<number> {
  const data = await post<{ renamed: number }>(`${API.numberFiles}?path=${encodeURIComponent(path)}`)
  return data.renamed
}

// ── App mode images ──

/** The part of a mode's image the pill shows: fractions (0–1) of its width and height */
export interface ImageFrame {
  x: number
  y: number
  w: number
  h: number
}

/** A mode's image: its version (changes with each new image) and frame (null = centered square) */
export interface AppModeImageInfo {
  version: number
  frame: ImageFrame | null
}

/** Per mode: its image, or null if it has none */
export async function fetchAppModeImages(): Promise<Record<string, AppModeImageInfo | null>> {
  const res = await fetch(API.appModeImages)
  if (!res.ok) throw new Error(`Loading the app mode images failed (${res.status})`)
  return (await res.json()) as Record<string, AppModeImageInfo | null>
}

/** Makes `file` the image of `mode`, replacing the one it had */
export async function uploadAppModeImage(mode: string, file: File): Promise<void> {
  const ext = file.name.split('.').pop() ?? ''
  const res = await fetch(
    `${API.appModeImage}?mode=${encodeURIComponent(mode)}&ext=${encodeURIComponent(ext)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Uploading the ${mode} image failed (${res.status})`)
  }
}

/** Saves the part of `mode`'s image the pill shows */
export async function saveAppModeFrame(mode: string, frame: ImageFrame): Promise<void> {
  const res = await fetch(`${API.appModeFrame}?mode=${encodeURIComponent(mode)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(frame),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Saving the ${mode} image's frame failed (${res.status})`)
  }
}

/** An app mode image that was replaced or removed */
export interface HistoryImage {
  id: string
  /** Where to load it */
  url: string
  frame: ImageFrame | null
  /** The mode it was the image of */
  mode: string
  /** When it was replaced or removed (ms since 1970) */
  replacedAt: number
}

/** The app mode images replaced or removed, newest first */
export async function fetchAppModeHistory(): Promise<HistoryImage[]> {
  const res = await fetch(API.appModeHistory)
  if (!res.ok) throw new Error(`Loading the earlier images failed (${res.status})`)
  const list = (await res.json()) as Array<Omit<HistoryImage, 'url'>>
  return list.map((e) => ({
    ...e,
    url: `${API.appModeHistoryImage}?id=${encodeURIComponent(e.id)}`,
  }))
}

/** Makes the history image `id` the image of `mode` again (its current one goes to the history) */
export function restoreAppModeImage(mode: string, id: string): Promise<{ ok: true }> {
  return post(
    `${API.appModeImageRestore}?mode=${encodeURIComponent(mode)}&id=${encodeURIComponent(id)}`,
  )
}

/** Moves `mode`'s image to the history: it has none after */
export function removeAppModeImage(mode: string): Promise<{ ok: true }> {
  return post(`${API.appModeImageRemove}?mode=${encodeURIComponent(mode)}`)
}

/** Deletes an image of the history for good */
export function deleteAppModeHistoryImage(id: string): Promise<{ ok: true }> {
  return post(`${API.appModeHistoryDelete}?id=${encodeURIComponent(id)}`)
}

/** A running upload */
/** Where an upload was saved */
export interface Uploaded {
  /** The name it was saved under (a taken name gets " (2)" etc.) */
  name: string
  /** Its path inside the shared folder, e.g. to discard it again */
  path: string
}

export interface Upload {
  done: Promise<Uploaded>
  /**
   * Stops the upload; `done` then rejects with an UploadCancelled. The server
   * throws away the part it got, so nothing of the file is kept.
   */
  cancel(): void
}

export class UploadCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

/**
 * Sends a file from the device into the folder `dir`. Uses XMLHttpRequest
 * because fetch can't report upload progress: `onProgress` gets the bytes
 * sent so far.
 */
export function uploadFile(dir: string, file: File, onProgress: (sent: number) => void): Upload {
  const xhr = new XMLHttpRequest()
  const done = new Promise<Uploaded>((resolve, reject) => {
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      let data: { name?: string; path?: string; error?: string } = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // not JSON (e.g. a bare 500): keep the generic message below
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const name = data.name ?? file.name
        resolve({ name, path: data.path ?? (dir ? `${dir}/${name}` : name) })
      } else {
        reject(new Error(data.error ?? `Upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Connection lost'))
    xhr.onabort = () => reject(new UploadCancelled())
  })
  xhr.open(
    'POST',
    `${API.uploadFile}?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`,
  )
  xhr.setRequestHeader('Content-Type', 'application/octet-stream')
  xhr.send(file)
  return { done, cancel: () => xhr.abort() }
}

/**
 * Deletes a file that was just uploaded (the server refuses any other), for
 * good: the upload dialog's Cancel, which throws a whole batch away
 */
export async function discardUpload(path: string): Promise<void> {
  const res = await fetch(`${API.discardUpload}?path=${encodeURIComponent(path)}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Discarding failed (${res.status})`)
  }
}

// ── Compressing ──

// The server compresses in the background (server/compressQueue.ts); its
// changes arrive on the job events stream (useJobEvents → useCompressQueue)

/** The server's compress jobs, oldest first */
export async function fetchCompressJobs(): Promise<CompressJob[]> {
  const res = await fetch(API.compressJobs)
  if (!res.ok) throw new Error(`Loading the compress queue failed (${res.status})`)
  return ((await res.json()) as { jobs: CompressJob[] }).jobs
}

/**
 * Adds videos and photos to the server's compress queue. Answers the new jobs,
 * and the files refused with why (already queued, not a video or photo…)
 */
export async function queueCompress(
  entries: Entry[],
): Promise<{ queued: CompressJob[]; refused: Array<{ path: string; error: string }> }> {
  const res = await fetch(API.compressQueue, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: entries.map((e) => ({ path: e.path, duration: e.duration ?? null })),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    queued?: CompressJob[]
    refused?: Array<{ path: string; error: string }>
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? `Compressing failed (${res.status})`)
  return { queued: data.queued ?? [], refused: data.refused ?? [] }
}

/**
 * The part of a video to keep (seconds) and its crop (fractions 0–1 of the
 * picture as shown); a photo's start and end are unused
 */
export interface MediaEdit {
  start: number
  end: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * Adds a trimmed / cropped copy of a video or photo to the server's compress
 * queue, which saves it next to the original as "<name>_edited.<ext>" in the
 * background (the original is kept). With `compress`, that copy is
 * compressed too, and only the compressed one is kept. Answers the new job
 */
export async function queueEdit(
  path: string,
  edit: MediaEdit,
  compress = false,
): Promise<CompressJob> {
  const res = await fetch(API.compressEdit, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, edit, compress }),
  })
  const data = (await res.json().catch(() => ({}))) as { job?: CompressJob; error?: string }
  if (!res.ok || !data.job) throw new Error(data.error ?? `Saving the copy failed (${res.status})`)
  return data.job
}

/** Stops compress jobs (one, a folder's, or all), waiting or running; the copies already saved stay */
export async function cancelCompress(which: { id: string } | { folder: string } | 'all'): Promise<void> {
  const query =
    which === 'all'
      ? 'all=1'
      : 'id' in which
        ? `id=${encodeURIComponent(which.id)}`
        : `folder=${encodeURIComponent(which.folder)}`
  await post(`${API.compressCancel}?${query}`)
}

/** Deletes the copy a compress job saved (in the last day); the original stays */
export async function discardCompressJob(id: string): Promise<void> {
  await post(`${API.compressDiscard}?id=${encodeURIComponent(id)}`)
}

/** Removes the ended compress jobs of a folder (none given: all) from the list */
export async function clearCompressJobs(folder?: string): Promise<void> {
  await post(
    folder === undefined ? API.compressClear : `${API.compressClear}?folder=${encodeURIComponent(folder)}`,
  )
}

/** A compressed copy was opened: its card loses the "Compressed!" banner, on every device */
export async function markCompressedSeen(path: string): Promise<void> {
  await post(`${API.compressSeen}?path=${encodeURIComponent(path)}`)
}

export async function shutdownServer(): Promise<void> {
  await fetch(API.shutdown).catch(() => {})
}

// ── URLs ──

/** The original file */
export function fileUrl(path: string): string {
  return FILES_PREFIX + path.split('/').map(encodeURIComponent).join('/')
}

/** Still frame from the middle of a video, generated by the server (ffmpeg) */
export function thumbUrl(path: string): string {
  return `${API.thumb}?path=${encodeURIComponent(path)}&v=${stillVersion()}`
}

/** Grid of small frames for the player's slider preview, generated by the server */
export function storyboardUrl(path: string): string {
  return `${API.storyboard}?path=${encodeURIComponent(path)}`
}

/**
 * A video was played in the viewer, or a photo shown there: the server sets
 * "last viewed" of it and of every folder above it to now, and counts one
 * more play. Returns that time and the new count (both null in dev mode:
 * nothing was recorded, src/appMode.ts).
 */
export async function markViewed(
  path: string,
): Promise<{ viewed: number | null; plays: number | null }> {
  return post<{ viewed: number | null; plays: number | null }>(
    `${API.viewed}?path=${encodeURIComponent(path)}`,
  )
}

/**
 * A video was watched / photo shown in the viewer for `ms` more: added to its
 * time watched, on every device. Returns the new total (null in dev mode:
 * nothing was recorded, src/appMode.ts). `keepalive`, so it's still sent
 * while the page goes away.
 */
export async function addWatchTime(path: string, ms: number): Promise<number | null> {
  const res = await fetch(`${API.watchTime}?path=${encodeURIComponent(path)}&ms=${ms}`, {
    method: 'POST',
    keepalive: true,
  })
  const data = (await res.json().catch(() => ({}))) as { watched_ms?: number | null; error?: string }
  if (!res.ok) throw new Error(data.error ?? `Saving the time watched failed (${res.status})`)
  return data.watched_ms ?? null
}

/** Sets how long a video / photo was watched (ms), on every device. Refused in dev mode */
export async function setWatchTime(path: string, ms: number): Promise<void> {
  await post(`${API.setWatchTime}?path=${encodeURIComponent(path)}&ms=${ms}`)
}

/** Sets how many times a video / photo was viewed, on every device */
export async function setPlays(path: string, count: number): Promise<void> {
  await post(`${API.setPlays}?path=${encodeURIComponent(path)}&count=${count}`)
}

/**
 * Most played first, shared by every device: the `limit` videos and photos
 * inside a folder (subfolders included), or (`kind` 'folders') the `limit`
 * folders directly inside it, by the plays of everything in them added up.
 * `by` 'time': the longest watched first instead (time watched)
 */
export async function fetchMostPlayed(
  path: string,
  limit: number,
  kind: 'media' | 'folders' = 'media',
  by: 'plays' | 'time' = 'plays',
): Promise<Entry[]> {
  const res = await fetch(
    `${API.mostPlayed}?path=${encodeURIComponent(path)}&limit=${limit}&kind=${kind}&by=${by}`,
  )
  if (!res.ok) throw new Error(`Loading the most played failed (${res.status})`)
  return (await res.json()) as Entry[]
}

/** Up to `limit` hearted videos and photos inside a folder (subfolders included), in random order */
export async function fetchHearted(path: string, limit: number): Promise<Entry[]> {
  const res = await fetch(`${API.hearted}?path=${encodeURIComponent(path)}&limit=${limit}`)
  if (!res.ok) throw new Error(`Loading the hearted failed (${res.status})`)
  return (await res.json()) as Entry[]
}

/** How many times each part of a video was watched (HEATMAP_BINS numbers), or null if never */
export async function fetchHeatmap(path: string, signal?: AbortSignal): Promise<number[] | null> {
  const res = await fetch(`${API.heatmap}?path=${encodeURIComponent(path)}`, { signal })
  if (!res.ok) throw new Error(`Loading the most watched parts failed (${res.status})`)
  const data = (await res.json()) as { counts: number[] | null }
  return data.counts
}

/**
 * Adds how many times each part of a video was just watched, on every device.
 * `keepalive`, so it's still sent while the player closes or the page goes away.
 */
export async function sendHeatmap(path: string, counts: number[]): Promise<void> {
  const res = await fetch(`${API.heatmap}?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(counts),
    keepalive: true,
  })
  if (!res.ok) throw new Error(`Saving the most watched parts failed (${res.status})`)
}

/** Adds (`on`) or removes the heart of a video or photo; saved on the server for every device */
export async function setFavorite(path: string, on: boolean): Promise<void> {
  const res = await fetch(
    `${API.favorite}?path=${encodeURIComponent(path)}&on=${on ? 1 : 0}`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`Saving the favorite failed (${res.status})`)
}

/**
 * Looping clip of a folder: a slice of each of some random videos inside it,
 * or a slideshow of its images. The server keeps a few different random ones
 * per folder; `pick` (any whole number) chooses which, the same one every time.
 */
export function folderPreviewUrl(path: string, pick: number): string {
  return `${API.folderPreview}?path=${encodeURIComponent(path)}&pick=${pick}`
}

/**
 * Still of the folder preview that `pick` gets (its first video / image), so
 * the card can show it, blurred, until the clip plays. Answered right away,
 * even while the clip is still being built
 */
export function folderThumbUrl(path: string, pick: number): string {
  return `${API.folderThumb}?path=${encodeURIComponent(path)}&pick=${pick}&v=${stillVersion()}`
}

/** Short looping clip of slices spread across a video, generated by the server */
export function previewUrl(path: string): string {
  return `${API.preview}?path=${encodeURIComponent(path)}`
}
