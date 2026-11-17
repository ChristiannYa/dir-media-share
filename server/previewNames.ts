// Readable names for the cached preview clips, instead of hashes:
//   vid_<folder>_<n>.mp4  the preview of a video
//   dir_<folder>_<n>.mp4  a folder's preview (one per variant)
// <folder> is the folder's path inside the shared folder, its parts joined by
// "_" (".lock/.bin/.cinema/abelladanger" → "lock_bin_cinema_abelladanger");
// for a video it's the folder the video is in. <n> numbers the videos of that
// folder (1, 2, 3…), or the folder's variants.
//
// Each video / variant keeps its number: they're saved in PREVIEW_NAMES_FILE.
// Since a name no longer changes when the video is edited or the settings
// change (a hash did), the file also keeps which version each clip was built
// from (the hash `cacheName` makes of the source, its mtime and the
// settings). A clip of another version is stale: it's deleted and built again
// under the same name.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cacheFile, isRunning } from './cache.ts'
import {
  PREVIEW_DIR,
  PREVIEW_NAME_FOLDER_MAX_BYTES,
  PREVIEW_NAMES_FILE,
} from './consts/previews.ts'
import { resolveDir, resolveFile } from './paths.ts'

export type PreviewPrefix = 'vid' | 'dir'

interface Index {
  /** Source id (see videoId / folderId) → its clip's name, without ".mp4" */
  names: Record<string, string>
  /** Clip name → the version it was built from */
  built: Record<string, string>
}

function load(): Index {
  try {
    const saved = JSON.parse(readFileSync(PREVIEW_NAMES_FILE, 'utf8')) as Partial<Index>
    return {
      names: typeof saved.names === 'object' && saved.names ? saved.names : {},
      built: typeof saved.built === 'object' && saved.built ? saved.built : {},
    }
  } catch {
    return { names: {}, built: {} } // no file yet (or unreadable): names are given again
  }
}

const index = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const json = JSON.stringify(index, null, 2) + '\n'
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(PREVIEW_NAMES_FILE), { recursive: true })
    const tmp = `${PREVIEW_NAMES_FILE}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, PREVIEW_NAMES_FILE)
  })
  return saving
}

/** Names are handed out one at a time, so two new videos can't get the same number */
let naming: Promise<unknown> = Promise.resolve()

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const result = naming.then(task)
  naming = result.catch(() => {})
  return result
}

/** Id of a video's preview: its path inside the shared folder */
export function videoId(rel: string): string {
  return `vid:${rel}`
}

/** Id of one of a folder's previews: its path inside the shared folder and the variant */
export function folderId(rel: string, variant: number): string {
  return `dir:${rel}#${variant}`
}

/** The folder a video is in, as a path inside the shared folder ('' = the shared folder) */
export function folderOf(rel: string): string {
  const dir = path.posix.dirname(rel)
  return dir === '.' ? '' : dir
}

/**
 * A folder's path as the middle of a name: ".lock/.bin/x y" → "lock_bin_x_y".
 * Letters (any language), digits and "-" are kept; anything else becomes "_".
 * Also what "Number files by date" names a folder's files after
 * (handlers/files.ts), so a video and its preview share the name and number.
 */
export function folderPart(folderRel: string): string {
  if (!folderRel) return 'root'
  const joined = folderRel
    .split('/')
    .map((part) => part.replace(/^\.+/, '')) // hidden folders: no leading dots
    .join('_')
    .replace(/[^\p{L}\p{N}-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  // cut by bytes, not characters: file names may have 255 bytes
  let cut = ''
  for (const ch of joined) {
    if (Buffer.byteLength(cut + ch) > PREVIEW_NAME_FOLDER_MAX_BYTES) break
    cut += ch
  }
  return cut.replace(/_+$/, '') || 'folder'
}

/** True if the video or folder an id stands for still exists */
async function sourceExists(id: string): Promise<boolean> {
  if (id.startsWith('vid:')) return (await resolveFile(id.slice(4))) !== null
  if (id.startsWith('dir:')) return (await resolveDir(id.slice(4).replace(/#\d+$/, ''))) !== null
  return false
}

/**
 * The name for `id`: the one it already has, or the first free
 * "<prefix>_<folder>_<n>" (`preferred` n first, if free). Ids under the same
 * name whose video or folder is gone (moved, renamed, deleted) give their
 * numbers back first.
 */
function nameFor(
  prefix: PreviewPrefix,
  folderRel: string,
  id: string,
  preferred?: number,
): Promise<string> {
  const known = index.names[id]
  if (known) return Promise.resolve(known)

  return oneAtATime(async () => {
    const again = index.names[id]
    if (again) return again

    const base = `${prefix}_${folderPart(folderRel)}`
    const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`, 'u')
    const taken = new Set<number>()
    for (const [otherId, name] of Object.entries(index.names)) {
      const match = pattern.exec(name)
      if (!match) continue
      if (await sourceExists(otherId)) {
        taken.add(Number(match[1]))
      } else {
        delete index.names[otherId]
        delete index.built[name]
      }
    }

    let n = preferred !== undefined && preferred > 0 && !taken.has(preferred) ? preferred : 1
    if (n !== preferred) while (taken.has(n)) n++
    const name = `${base}_${n}`
    index.names[id] = name
    await save()
    return name
  })
}

/**
 * The clip file for `id`, ready to be built: its name (see nameFor) and path.
 * A clip already there that was built from another `version` is deleted, so
 * it gets built again.
 */
export async function previewFile(
  prefix: PreviewPrefix,
  folderRel: string,
  id: string,
  version: string,
  preferred?: number,
): Promise<{ name: string; out: string }> {
  const name = await nameFor(prefix, folderRel, id, preferred)
  const out = await cacheFile(PREVIEW_DIR, name, 'mp4')
  // not while it's being built: that build is the new version
  if (index.built[name] !== version && !isRunning(out)) await unlink(out).catch(() => {})
  return { name, out }
}

/** Records that the clip `name` now holds `version` */
export async function markBuilt(name: string, version: string): Promise<void> {
  if (index.built[name] === version) return
  index.built[name] = version
  await save()
}

/** One video whose preview gets a new name (see movePreviews) */
export interface PreviewMove {
  /** The video's old and new path inside the shared folder (the same if only its preview is renamed) */
  from: string
  to: string
  /** The preview's new name, without ".mp4" (vid_<folder>_<n>) */
  name: string
  /** Version of the video under its old path, and under its new one (see previewFile) */
  oldVersion: string
  newVersion: string
}

/**
 * Videos were renamed (or renumbered): each preview gets its new name. A clip
 * already built for the video keeps going: it's renamed too, not built again.
 * Two steps, so a clip can take a name another one is leaving: the kept clips
 * first step aside, then each moves to its new name. Anything else holding
 * one of the new names (another folder's video with the same <folder> part)
 * gives it up and gets a new number the next time it's asked for.
 */
export function movePreviews(moves: PreviewMove[]): Promise<void> {
  return oneAtATime(async () => {
    const newNames = new Set(moves.map((m) => m.name))
    const movingIds = new Set(moves.map((m) => videoId(m.from)))
    for (const [id, name] of Object.entries(index.names)) {
      if (newNames.has(name) && !movingIds.has(id)) delete index.names[id]
    }

    // 1: each clip built for its video's current version steps aside
    const parked = new Map<PreviewMove, string>()
    for (const move of moves) {
      const id = videoId(move.from)
      const oldName = index.names[id]
      delete index.names[id]
      if (!oldName) continue
      const current = index.built[oldName] === move.oldVersion
      delete index.built[oldName]
      const oldOut = await cacheFile(PREVIEW_DIR, oldName, 'mp4')
      if (!current || isRunning(oldOut)) continue
      const tmp = path.join(PREVIEW_DIR, `.${randomUUID()}.mp4`)
      if (await rename(oldOut, tmp).then(() => true, () => false)) parked.set(move, tmp)
    }

    // 2: every video takes its new name; its clip moves in
    for (const move of moves) {
      index.names[videoId(move.to)] = move.name
      delete index.built[move.name]
      const out = await cacheFile(PREVIEW_DIR, move.name, 'mp4')
      const tmp = parked.get(move)
      if (tmp && (await rename(tmp, out).then(() => true, () => false))) {
        index.built[move.name] = move.newVersion
      } else {
        // whatever is there was built for another video: it mustn't be served
        await unlink(out).catch(() => {})
        if (tmp) await unlink(tmp).catch(() => {})
      }
    }
    await save()
  })
}

/** The path of the clip `id` has, or null if it never got a name (nothing to delete) */
export async function existingPreviewFile(id: string): Promise<string | null> {
  const name = index.names[id]
  return name ? cacheFile(PREVIEW_DIR, name, 'mp4') : null
}
