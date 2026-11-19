// Changing files: upload, move to the trash, move to another folder, rename,
// and listing folders to move into.

import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isDevMode } from '../appMode.ts'
import { cacheFile, cacheName, exists } from '../cache.ts'
import { moveCompressedNew, renameCompressedNew, setCompressedSeen } from '../compressedNew.ts'
import { moveFavorite, moveFavorites, renameFavorites, setFavorite } from '../favorites.ts'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../consts/fileTypes.ts'
import { forgetHeatmap, moveHeatmaps } from '../heatmap.ts'
import { THUMB_DIR } from '../consts/thumbnails.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { sendJson, sendStatus, type Handler } from '../http.ts'
import { addedTime, isVideoName } from '../listing.ts'
import * as preview from '../media/preview.ts'
import { purgeVideo } from '../media/purge.ts'
import * as thumbnail from '../media/thumbnail.ts'
import { claimName } from '../names.ts'
import { relativePath, resolveDir, resolveFile } from '../paths.ts'
import { folderPart, movePreviews, type PreviewMove } from '../previewNames.ts'
import { countPlay, forgetPlays, movePlays, setPlayCount } from '../plays.ts'
import { moveToTrash } from '../trash.ts'
import { forgetView, markViewed, moveViews } from '../views.ts'
import { addWatchTime, forgetWatchTime, moveWatchTime, setWatchTime } from '../watchTime.ts'
import { WATCH_TIME_MAX_ADD_MS, WATCH_TIME_MAX_SET_MS } from '../consts/server.ts'

/** GET /api/folders?path= : names and paths of the subfolders of a folder */
export const folders: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const dir = await resolveDir(rel)
  if (!dir) return sendJson(res, [])

  const names = await readdir(dir).catch(() => [] as string[])
  const found: Array<{ name: string; path: string }> = []
  for (const name of names) {
    const info = await stat(path.join(dir, name)).catch(() => null)
    if (info?.isDirectory()) found.push({ name, path: rel ? `${rel}/${name}` : name })
  }
  found.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  sendJson(res, found)
}

/**
 * POST /api/file/trash?path= : moves a file to the desktop's trash (it can be
 * restored from the file manager) and removes its cached still/preview/storyboard
 */
export const trashFile: Handler = async (_req, res, url) => {
  const file = await resolveFile(url.searchParams.get('path') ?? '')
  if (!file) return sendStatus(res, 404)

  // the cache names are worked out from the file, so do this while it's still there
  if (isVideoName(path.basename(file))) await purgeVideo(file).catch(() => 0)
  try {
    await moveToTrash(file)
  } catch (e) {
    console.error(`Moving ${file} to the trash failed:`, e)
    return sendJson(res, { error: 'The file could not be moved to the trash' }, 500)
  }
  console.log(`Trashed ${file}`)
  // favorites are keyed by the path the listing shows (the one asked for)
  await setFavorite(url.searchParams.get('path') ?? '', false).catch((e) =>
    console.error('Updating the favorites failed:', e),
  )
  await forgetView(url.searchParams.get('path') ?? '').catch((e) =>
    console.error('Updating the views failed:', e),
  )
  await forgetPlays(url.searchParams.get('path') ?? '').catch((e) =>
    console.error('Updating the play counts failed:', e),
  )
  await forgetWatchTime(url.searchParams.get('path') ?? '').catch((e) =>
    console.error('Updating the time watched failed:', e),
  )
  await forgetHeatmap(url.searchParams.get('path') ?? '').catch((e) =>
    console.error('Updating the heatmaps failed:', e),
  )
  await setCompressedSeen(url.searchParams.get('path') ?? '').catch((e) =>
    console.error('Updating the new compressed copies failed:', e),
  )
  sendJson(res, { trashed: await relativePath(file) })
}

/**
 * POST /api/favorite?path=&on=1 (or 0) : adds or removes the heart of a video
 * or photo. Answers `{ favorite }`, the new state. Refused in dev mode
 * (server/appMode.ts).
 */
export const favoriteFile: Handler = async (req, res, url) => {
  if (isDevMode(req)) return sendJson(res, { error: 'Hearts can only be changed in goon mode' }, 403)
  // kept by the path the listing shows (server/listing.ts looks it up the same way)
  const rel = url.searchParams.get('path') ?? ''
  if (!(await resolveFile(rel))) return sendStatus(res, 404)
  const on = url.searchParams.get('on') === '1'
  try {
    await setFavorite(rel, on)
  } catch (e) {
    console.error('Saving the favorites failed:', e)
    return sendJson(res, { error: 'The favorite could not be saved' }, 500)
  }
  sendJson(res, { favorite: on })
}

/**
 * POST /api/viewed?path= : the video was just played in the viewer, or the
 * photo shown there: it and every folder above it get "last viewed" = now
 * (server/views.ts), and its play count goes up by one (server/plays.ts).
 * Answers `{ viewed, plays }`: that time and the new count. Dev mode
 * (server/appMode.ts): nothing is saved, and both are null.
 */
export const viewedFile: Handler = async (req, res, url) => {
  if (isDevMode(req)) return sendJson(res, { viewed: null, plays: null })
  // kept by the path the listing shows (server/listing.ts looks it up the same way)
  const rel = url.searchParams.get('path') ?? ''
  const file = await resolveFile(rel)
  if (!file || !isMediaName(path.basename(file))) return sendStatus(res, 404)
  try {
    const viewed = await markViewed(rel)
    sendJson(res, { viewed, plays: await countPlay(rel) })
  } catch (e) {
    console.error('Saving the views failed:', e)
    sendJson(res, { error: 'The view could not be saved' }, 500)
  }
}

/**
 * POST /api/watch-time?path=&ms= : the video was just watched, or the photo
 * shown, in the viewer for `ms` more (a whole number, up to
 * WATCH_TIME_MAX_ADD_MS): added to its time watched (server/watchTime.ts).
 * Answers `{ watched_ms }`, the new total. Dev mode (server/appMode.ts):
 * nothing is saved, and it's null.
 */
export const watchedFile: Handler = async (req, res, url) => {
  if (isDevMode(req)) return sendJson(res, { watched_ms: null })
  // kept by the path the listing shows (server/listing.ts looks it up the same way)
  const rel = url.searchParams.get('path') ?? ''
  const file = await resolveFile(rel)
  if (!file || !isMediaName(path.basename(file))) return sendStatus(res, 404)
  const ms = Number(url.searchParams.get('ms'))
  if (!Number.isInteger(ms) || ms <= 0 || ms > WATCH_TIME_MAX_ADD_MS) {
    return sendJson(res, { error: `ms must be a whole number from 1 to ${WATCH_TIME_MAX_ADD_MS}` }, 400)
  }
  try {
    sendJson(res, { watched_ms: await addWatchTime(rel, ms) })
  } catch (e) {
    console.error('Saving the time watched failed:', e)
    sendJson(res, { error: 'The time watched could not be saved' }, 500)
  }
}

/**
 * POST /api/watch-time/set?path=&ms= : sets how long a video / photo was
 * watched (the metadata dialog), on every device (server/watchTime.ts).
 * Answers `{ watched_ms }`. Refused in dev mode (server/appMode.ts).
 */
export const setWatched: Handler = async (req, res, url) => {
  if (isDevMode(req)) {
    return sendJson(res, { error: 'Time watched can only be changed in goon mode' }, 403)
  }
  // kept by the path the listing shows (server/listing.ts looks it up the same way)
  const rel = url.searchParams.get('path') ?? ''
  const file = await resolveFile(rel)
  if (!file || !isMediaName(path.basename(file))) return sendStatus(res, 404)
  const ms = Number(url.searchParams.get('ms'))
  if (!Number.isInteger(ms) || ms < 0 || ms > WATCH_TIME_MAX_SET_MS) {
    return sendJson(res, { error: 'Time watched must be 0 to 100 000 hours' }, 400)
  }
  try {
    await setWatchTime(rel, ms)
  } catch (e) {
    console.error('Saving the time watched failed:', e)
    return sendJson(res, { error: 'The time watched could not be saved' }, 500)
  }
  sendJson(res, { watched_ms: ms })
}

/** Highest view count that can be set by hand */
const MAX_PLAYS = 1_000_000

/**
 * POST /api/plays?path=&count= : sets how many times a video / photo was
 * viewed (the metadata dialog), on every device (server/plays.ts). Answers `{ plays }`.
 * Setting 0 also sets its own "last viewed" back to never (server/views.ts; the
 * folders above it keep theirs, as when a file is trashed).
 * Refused in dev mode (server/appMode.ts).
 */
export const setPlays: Handler = async (req, res, url) => {
  if (isDevMode(req)) return sendJson(res, { error: 'Views can only be changed in goon mode' }, 403)
  // kept by the path the listing shows (server/listing.ts looks it up the same way)
  const rel = url.searchParams.get('path') ?? ''
  const file = await resolveFile(rel)
  if (!file || !isMediaName(path.basename(file))) return sendStatus(res, 404)
  const count = Number(url.searchParams.get('count'))
  if (!Number.isInteger(count) || count < 0 || count > MAX_PLAYS) {
    return sendJson(res, { error: `Views must be a whole number from 0 to ${MAX_PLAYS}` }, 400)
  }
  try {
    await setPlayCount(rel, count)
    // never viewed: no "last viewed" either
    if (count === 0) await forgetView(rel)
  } catch (e) {
    console.error('Saving the play counts failed:', e)
    return sendJson(res, { error: 'The views could not be saved' }, 500)
  }
  sendJson(res, { plays: count })
}

/**
 * POST /api/file/move?path=&to= : moves a file into the folder `to`, keeping
 * its name. Refuses to overwrite a file that's already there.
 */
export const moveFile: Handler = async (_req, res, url) => {
  const file = await resolveFile(url.searchParams.get('path') ?? '')
  const dest = await resolveDir(url.searchParams.get('to') ?? '')
  if (!file || !dest) return sendJson(res, { error: 'File or folder not found' }, 404)

  const name = path.basename(file)
  const target = path.join(dest, name)
  if (target === file) return sendJson(res, { error: 'It is already in that folder' }, 400)
  if (await exists(target)) {
    return sendJson(res, { error: `"${name}" already exists in that folder` }, 409)
  }

  try {
    await rename(file, target)
  } catch (e) {
    // rename can't cross drives (e.g. a symlinked folder on another disk): copy, then delete
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
      console.error(`Moving ${file} failed:`, e)
      return sendJson(res, { error: 'The file could not be moved' }, 500)
    }
    await copyFile(file, target, constants.COPYFILE_EXCL)
    await unlink(file)
  }
  console.log(`Moved ${file} → ${target}`)
  // favorites are keyed by the paths the listing shows (the ones asked for)
  const fromRel = url.searchParams.get('path') ?? ''
  const toDir = url.searchParams.get('to') ?? ''
  await moveFavorite(fromRel, toDir ? `${toDir}/${name}` : name).catch((e) =>
    console.error('Updating the favorites failed:', e),
  )
  await moveViews([[fromRel, toDir ? `${toDir}/${name}` : name]]).catch((e) =>
    console.error('Updating the views failed:', e),
  )
  await movePlays([[fromRel, toDir ? `${toDir}/${name}` : name]]).catch((e) =>
    console.error('Updating the play counts failed:', e),
  )
  await moveWatchTime([[fromRel, toDir ? `${toDir}/${name}` : name]]).catch((e) =>
    console.error('Updating the time watched failed:', e),
  )
  await moveHeatmaps([[fromRel, toDir ? `${toDir}/${name}` : name]]).catch((e) =>
    console.error('Updating the heatmaps failed:', e),
  )
  await moveCompressedNew([[fromRel, toDir ? `${toDir}/${name}` : name]]).catch((e) =>
    console.error('Updating the new compressed copies failed:', e),
  )
  sendJson(res, { path: await relativePath(target) })
}

/**
 * How long after an upload the upload dialog's Cancel may still delete it.
 * Long enough for any batch; short enough that this can't be used to delete
 * the gallery's other files.
 */
const DISCARD_WINDOW_MS = 24 * 60 * 60 * 1000

/** Files saved by an upload (real path → when), so Cancel can discard them; nothing else can be */
const recentUploads = new Map<string, number>()

function rememberUpload(file: string) {
  const now = Date.now()
  for (const [f, at] of recentUploads) if (now - at > DISCARD_WINDOW_MS) recentUploads.delete(f)
  recentUploads.set(file, now)
}

/**
 * POST /api/file/discard?path= : deletes a file saved by an upload in the last
 * DISCARD_WINDOW_MS, for good (not to the trash), with its cached still,
 * preview and storyboard. Used by the upload dialog's Cancel, which throws
 * away a whole batch. Any other file is refused.
 */
export const discardUpload: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const file = await resolveFile(rel)
  if (!file) return sendStatus(res, 404)
  const at = recentUploads.get(file)
  if (at === undefined || Date.now() - at > DISCARD_WINDOW_MS) {
    return sendJson(res, { error: 'Only files that were just uploaded can be discarded' }, 403)
  }

  // the cache names are worked out from the file, so do this while it's still there
  if (isVideoName(path.basename(file))) await purgeVideo(file).catch(() => 0)
  try {
    await unlink(file)
  } catch (e) {
    console.error(`Discarding the upload ${file} failed:`, e)
    return sendJson(res, { error: 'The file could not be deleted' }, 500)
  }
  recentUploads.delete(file)
  await setFavorite(rel, false).catch(() => {})
  console.log(`Discarded upload ${file}`)
  sendJson(res, { discarded: rel })
}

/** The bare file name of an upload, or null if it can't be used as one */
function uploadName(raw: string): string | null {
  // keep only the last part, whatever separator the device used
  const name = raw.split(/[/\\]/).pop()?.trim() ?? ''
  if (!name || name === '.' || name === '..' || name.includes('\0')) return null
  return name
}

/** True for names the gallery shows as an image or a video */
function isMediaName(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase()
  return IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)
}

/**
 * POST /api/file/upload?dir=&name= : the body is the file itself. It's written
 * to a hidden ".part" file first, so a cancelled or broken upload never shows
 * up half-written in the gallery, then renamed. Only images and videos.
 */
export const uploadFile: Handler = async (req, res, url) => {
  const dir = await resolveDir(url.searchParams.get('dir') ?? '')
  if (!dir) return sendJson(res, { error: 'Folder not found' }, 404)
  const name = uploadName(url.searchParams.get('name') ?? '')
  if (!name) return sendJson(res, { error: 'Invalid file name' }, 400)
  if (!isMediaName(name)) {
    return sendJson(res, { error: 'Only images and videos can be uploaded' }, 415)
  }

  const part = path.join(dir, `.${randomUUID()}${UPLOAD_PART_SUFFIX}`)
  try {
    await pipeline(req, createWriteStream(part, { flags: 'wx' }))
  } catch (e) {
    await unlink(part).catch(() => {})
    // the browser cancelled: nobody is left to answer
    if (req.destroyed || res.destroyed) return
    console.error(`Uploading ${name} into ${dir} failed:`, e)
    return sendJson(res, { error: 'The file could not be saved' }, 500)
  }

  let target: string
  try {
    target = await claimName(part, dir, name)
  } catch (e) {
    await unlink(part).catch(() => {})
    console.error(`Saving the upload ${name} into ${dir} failed:`, e)
    return sendJson(res, { error: 'The file could not be saved' }, 500)
  }
  console.log(`Uploaded ${target}`)
  rememberUpload(target)
  sendJson(res, { path: await relativePath(target), name: path.basename(target) })
}

/** Why a name (new folder, rename) can't be used, or null if it's fine */
function nameProblem(name: string): string | null {
  if (!name) return 'Enter a name'
  if (name === '.' || name === '..') return 'That name is reserved'
  if (/[/\\\0]/.test(name)) return 'A name can\'t contain / or \\'
  if (Buffer.byteLength(name) > 255) return 'That name is too long'
  return null
}

/** POST /api/folder/create?dir=&name= : makes an empty subfolder; refuses a taken name */
export const createFolder: Handler = async (_req, res, url) => {
  const dir = await resolveDir(url.searchParams.get('dir') ?? '')
  if (!dir) return sendJson(res, { error: 'Folder not found' }, 404)
  const name = (url.searchParams.get('name') ?? '').trim()
  const problem = nameProblem(name)
  if (problem) return sendJson(res, { error: problem }, 400)

  const target = path.join(dir, name)
  try {
    await mkdir(target) // not recursive: fails if the name is taken
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return sendJson(res, { error: `"${name}" already exists here` }, 409)
    }
    console.error(`Creating ${target} failed:`, e)
    return sendJson(res, { error: 'The folder could not be created' }, 500)
  }
  console.log(`Created folder ${target}`)
  sendJson(res, { path: await relativePath(target) })
}

/**
 * POST /api/folder/number?path= : renames the photos and videos directly in a
 * folder after it, numbered by age: <folder>_1.<ext> for the oldest, then _2,
 * _3… <folder> is the folder's path as in preview names (".lock/.bin/x" →
 * "lock_bin_x", server/previewNames.ts), and each video's preview is renamed
 * to vid_<folder>_<n> with the same n. Hearts, stills and already built
 * previews follow their files, so nothing is built again. Other files and
 * subfolders are left alone. Answers `{ renamed }`: how many files got a new
 * name.
 */
export const numberFiles: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const dir = await resolveDir(rel)
  if (!dir) return sendJson(res, { error: 'Folder not found' }, 404)
  const relOf = (name: string) => (rel ? `${rel}/${name}` : name)

  // the photos and videos directly inside, oldest first (same date: by name).
  // Uploads still in progress end in ".part", so they aren't media names
  const files: Array<{ name: string; added: number }> = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!isMediaName(name)) continue
    const info = await stat(path.join(dir, name)).catch(() => null)
    if (info?.isFile()) files.push({ name, added: addedTime(info) })
  }
  files.sort((a, b) => a.added - b.added || a.name.localeCompare(b.name))

  const slug = folderPart(rel)
  const plan = files.map((f, i) => ({
    from: f.name,
    to: `${slug}_${i + 1}${path.extname(f.name)}`,
    n: i + 1,
  }))
  const moving = plan.filter((p) => p.from !== p.to)

  // a new name may only be taken by one of these files (it moves away first)
  const ours = new Set(files.map((f) => f.name))
  for (const p of moving) {
    if (!ours.has(p.to) && (await lstat(path.join(dir, p.to)).catch(() => null))) {
      return sendJson(res, { error: `"${p.to}" already exists in this folder` }, 409)
    }
  }

  // stills and previews are named after the video's path: note them before it changes
  const videos = plan.filter((p) => isVideoName(p.from))
  const before = new Map<string, { thumb: string; version: string }>()
  for (const p of videos) {
    const full = path.join(dir, p.from)
    before.set(p.from, {
      thumb: await cacheFile(THUMB_DIR, await cacheName(full, thumbnail.cacheSettings()), 'jpg'),
      version: await preview.previewVersion(full),
    })
  }

  // two steps, so a file can take a name another one is leaving: every file
  // to a hidden temporary name first, then each to its new name
  const tag = randomUUID()
  const tmpOf = (i: number) => path.join(dir, `.${tag}-${i}.renaming`)
  const state = moving.map(() => 'old' as 'old' | 'parked' | 'new')
  try {
    for (const [i, p] of moving.entries()) {
      await rename(path.join(dir, p.from), tmpOf(i))
      state[i] = 'parked'
    }
    for (const [i, p] of moving.entries()) {
      await rename(tmpOf(i), path.join(dir, p.to))
      state[i] = 'new'
    }
  } catch (e) {
    // put every file back under its old name, the same two steps backwards
    for (const [i, p] of moving.entries()) {
      if (state[i] !== 'new') continue
      if (await rename(path.join(dir, p.to), tmpOf(i)).then(() => true, () => false)) {
        state[i] = 'parked'
      }
    }
    for (const [i, p] of moving.entries()) {
      if (state[i] === 'parked') await rename(tmpOf(i), path.join(dir, p.from)).catch(() => {})
    }
    console.error(`Numbering the files of ${dir} failed:`, e)
    return sendJson(res, { error: 'The files could not be renamed' }, 500)
  }
  console.log(`Numbered ${moving.length} files in ${dir}`)

  // hearts are kept by the path the listing shows
  await moveFavorites(moving.map((p) => [relOf(p.from), relOf(p.to)])).catch((e) =>
    console.error('Updating the favorites failed:', e),
  )
  await moveViews(moving.map((p) => [relOf(p.from), relOf(p.to)])).catch((e) =>
    console.error('Updating the views failed:', e),
  )
  await movePlays(moving.map((p) => [relOf(p.from), relOf(p.to)])).catch((e) =>
    console.error('Updating the play counts failed:', e),
  )
  await moveWatchTime(moving.map((p) => [relOf(p.from), relOf(p.to)])).catch((e) =>
    console.error('Updating the time watched failed:', e),
  )
  await moveHeatmaps(moving.map((p) => [relOf(p.from), relOf(p.to)])).catch((e) =>
    console.error('Updating the heatmaps failed:', e),
  )
  await moveCompressedNew(moving.map((p) => [relOf(p.from), relOf(p.to)])).catch((e) =>
    console.error('Updating the new compressed copies failed:', e),
  )

  // stills: the same picture, under the name made from the new path
  for (const p of videos) {
    if (p.from === p.to) continue
    const thumb = await cacheFile(
      THUMB_DIR,
      await cacheName(path.join(dir, p.to), thumbnail.cacheSettings()),
      'jpg',
    )
    await rename(before.get(p.from)?.thumb ?? '', thumb).catch(() => {}) // none built yet: fine
  }

  // previews: vid_<folder>_<n>, the same n as the video's file (also for
  // videos that already had the right file name)
  const moves: PreviewMove[] = []
  for (const p of videos) {
    moves.push({
      from: relOf(p.from),
      to: relOf(p.to),
      name: `vid_${slug}_${p.n}`,
      oldVersion: before.get(p.from)?.version ?? '',
      newVersion: await preview.previewVersion(path.join(dir, p.to)),
    })
  }
  await movePreviews(moves).catch((e) => console.error('Renaming the previews failed:', e))

  sendJson(res, { renamed: moving.length })
}

/**
 * POST /api/rename?path=&name= : renames a file or folder where it is.
 * Refuses a taken name. Its favorites (a folder's: everything inside) follow it.
 */
export const renameEntry: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const name = (url.searchParams.get('name') ?? '').trim()
  const oldName = path.posix.basename(rel)
  if (!rel || oldName === '.' || oldName === '..') {
    return sendJson(res, { error: 'That cannot be renamed' }, 400)
  }
  const problem = nameProblem(name)
  if (problem) return sendJson(res, { error: problem }, 400)

  // resolve the parent, not the entry: a symlink must be renamed itself,
  // not whatever it points to
  const parentRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
  const dir = await resolveDir(parentRel)
  const from = dir && path.join(dir, oldName)
  const self = from && (await lstat(from).catch(() => null))
  if (!dir || !from || !self) return sendJson(res, { error: 'Not found' }, 404)

  const newRel = parentRel ? `${parentRel}/${name}` : name
  if (name === oldName) return sendJson(res, { path: newRel })

  // rename() silently replaces a file (or an empty folder) at the target.
  // Comparing inodes still allows a case-only change (clip → Clip) on drives
  // that ignore case.
  const target = path.join(dir, name)
  const taken = await lstat(target).catch(() => null)
  if (taken && !(taken.ino === self.ino && taken.dev === self.dev)) {
    return sendJson(res, { error: `"${name}" already exists here` }, 409)
  }

  try {
    await rename(from, target)
  } catch (e) {
    console.error(`Renaming ${from} failed:`, e)
    return sendJson(res, { error: 'It could not be renamed' }, 500)
  }
  console.log(`Renamed ${from} → ${target}`)
  // favorites are keyed by the paths the listing shows (the ones asked for)
  await renameFavorites(rel, newRel).catch((e) =>
    console.error('Updating the favorites failed:', e),
  )
  await moveViews([[rel, newRel]]).catch((e) => console.error('Updating the views failed:', e))
  await movePlays([[rel, newRel]]).catch((e) =>
    console.error('Updating the play counts failed:', e),
  )
  await moveWatchTime([[rel, newRel]]).catch((e) =>
    console.error('Updating the time watched failed:', e),
  )
  await moveHeatmaps([[rel, newRel]]).catch((e) =>
    console.error('Updating the heatmaps failed:', e),
  )
  // a folder's: everything inside it
  await renameCompressedNew(rel, newRel).catch((e) =>
    console.error('Updating the new compressed copies failed:', e),
  )
  sendJson(res, { path: newRel })
}
