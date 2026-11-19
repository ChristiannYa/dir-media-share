// Moving files to the desktop's trash (freedesktop.org Trash spec), so the
// file manager can restore them; and the app's own trash view (handlers/trash.ts):
// listing what's in it, putting an item back where it was, deleting it for good.
//
// A trashed file goes to TRASH_DIR/files/<name>, next to a small
// TRASH_DIR/info/<name>.trashinfo that records where it came from and when.
//
// The desktop's trash holds everything deleted on the computer, so the app
// only ever sees, restores, deletes or serves the items that came from the
// shared folder (their .trashinfo says so); the rest isn't its business.

import { constants } from 'node:fs'
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { exists } from './cache.ts'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './consts/fileTypes.ts'
import { TRASH_DIR } from './consts/trash.ts'
import { baseDir, SHARE_ROOT } from './paths.ts'

const FILES_DIR = path.join(TRASH_DIR, 'files')
const INFO_DIR = path.join(TRASH_DIR, 'info')

/** Local time as YYYY-MM-DDThh:mm:ss, the format the spec asks for */
function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function trashInfo(original: string, date: Date): string {
  // the original path is stored URL-encoded, keeping the slashes
  const encoded = original.split('/').map(encodeURIComponent).join('/')
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${localTimestamp(date)}\n`
}

/**
 * Picks a name not used in the trash yet ("clip.mp4", "clip.2.mp4", …) and
 * claims it by creating its .trashinfo; creating it exclusively makes sure
 * two deletions can't pick the same name. Returns the name.
 */
async function claimName(name: string, info: string): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${base}.${i}${ext}`
    const infoFile = path.join(INFO_DIR, `${candidate}.trashinfo`)
    try {
      await writeFile(infoFile, info, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    // a leftover file without its info: don't overwrite it, try the next name
    if (await exists(path.join(FILES_DIR, candidate))) {
      await unlink(infoFile)
      continue
    }
    return candidate
  }
}

/** Moves `file` (absolute path) to the trash */
export async function moveToTrash(file: string): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true })
  await mkdir(INFO_DIR, { recursive: true })

  const name = await claimName(path.basename(file), trashInfo(file, new Date()))
  const target = path.join(FILES_DIR, name)
  try {
    await rename(file, target)
  } catch (e) {
    // rename can't cross drives (e.g. a folder on another disk): copy, then remove
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(file, target, constants.COPYFILE_EXCL)
      await unlink(file)
      return
    }
    await unlink(path.join(INFO_DIR, `${name}.trashinfo`)).catch(() => {})
    throw e
  }
}

// ── The app's trash view ──

/** An item of the trash that came from the shared folder */
export interface TrashItem {
  /** Its name in the trash (TRASH_DIR/files/<id>): what the other calls take */
  id: string
  /** Its name where it was */
  name: string
  /** Where it was, inside the shared folder ("/" separators, as the listing shows paths) */
  path: string
  /** The folder it was in ('' = the shared folder itself) */
  folder: string
  kind: 'video' | 'image' | 'file' | 'folder'
  /** Bytes (a folder: 0, not added up) */
  size: number
  /** When it was deleted (ms since 1970); null if the trash didn't say */
  deletedAt: number | null
}

/** A problem to show the user as is */
export class TrashError extends Error {}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep)
}

/**
 * Where an item came from, read from its .trashinfo: the absolute path and
 * when; null if it can't be read
 */
async function readInfo(id: string): Promise<{ original: string; deletedAt: number | null } | null> {
  const text = await readFile(path.join(INFO_DIR, `${id}.trashinfo`), 'utf8').catch(() => null)
  if (text === null) return null
  const field = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim()
  const encoded = field('Path')
  if (!encoded) return null
  let original: string
  try {
    // stored URL-encoded (see trashInfo)
    original = decodeURIComponent(encoded)
  } catch {
    return null
  }
  // relative paths belong to trashes on other drives, which this one isn't
  if (!path.isAbsolute(original)) return null
  // local time without a zone, as the spec asks: Date reads it as local time
  const date = field('DeletionDate')
  const at = date ? new Date(date).getTime() : NaN
  return { original: path.normalize(original), deletedAt: Number.isFinite(at) ? at : null }
}

/**
 * The original's path relative to the shared folder, or null if it wasn't in
 * it. Checked against both the folder as configured and with its symlinks
 * resolved (the app trashes real paths; a file manager may record either)
 */
async function relativeToShare(original: string): Promise<string | null> {
  for (const root of new Set([await baseDir(), SHARE_ROOT])) {
    if (isInside(original, root)) return path.relative(root, original).split(path.sep).join('/')
  }
  return null
}

/** A trash name the client may ask about: a plain name, nothing that climbs out */
function isPlainId(id: string): boolean {
  return !!id && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\0')
}

function kindOf(name: string, isFolder: boolean): TrashItem['kind'] {
  if (isFolder) return 'folder'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  return 'file'
}

/** The item `id`, if it's in the trash and came from the shared folder; null otherwise */
export async function trashItem(id: string): Promise<TrashItem | null> {
  if (!isPlainId(id)) return null
  const info = await readInfo(id)
  if (!info) return null
  const rel = await relativeToShare(info.original)
  if (!rel) return null
  // lstat: a symlink is listed as itself, never followed out of the trash
  const stats = await lstat(path.join(FILES_DIR, id)).catch(() => null)
  if (!stats) return null
  const folder = path.posix.dirname(rel)
  return {
    id,
    name: path.posix.basename(rel),
    path: rel,
    folder: folder === '.' ? '' : folder,
    kind: kindOf(rel, stats.isDirectory()),
    size: stats.isFile() ? stats.size : 0,
    deletedAt: info.deletedAt,
  }
}

/** Every item of the trash that came from the shared folder, the last deleted first */
export async function listTrash(): Promise<TrashItem[]> {
  const infos = await readdir(INFO_DIR).catch(() => [] as string[])
  const items = await Promise.all(
    infos
      .filter((n) => n.endsWith('.trashinfo'))
      .map((n) => trashItem(n.slice(0, -'.trashinfo'.length))),
  )
  return items
    .filter((i): i is TrashItem => i !== null)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}

/** The trashed file of `item`, to serve it (photos and videos are shown before restoring) */
export function trashedFile(item: TrashItem): string {
  return path.join(FILES_DIR, item.id)
}

/** "clip.mp4", then "clip (2).mp4", "clip (3).mp4"… (as server/names.ts names copies) */
function numberedName(name: string, n: number): string {
  if (n === 1) return name
  const ext = path.extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}

/**
 * Puts the item back where it was deleted from: its folder is made again if
 * it's gone, and if its name is taken there now (e.g. a file that replaced
 * it), it's restored as "name (2)". Never overwrites anything. Answers its
 * path inside the shared folder. Throws a TrashError the user can read
 */
export async function restoreFromTrash(id: string): Promise<string> {
  const item = await trashItem(id)
  if (!item) throw new TrashError('It is no longer in the trash')
  const base = await baseDir()
  const dir = path.join(base, ...(item.folder ? item.folder.split('/') : []))
  // the folder it was in: inside the shared folder (checked again, in case)
  if (dir !== base && !isInside(dir, base)) throw new TrashError('Its folder is outside the shared folder')
  await mkdir(dir, { recursive: true })

  const from = trashedFile(item)
  const isFolder = item.kind === 'folder'
  for (let n = 1; n <= 9999; n++) {
    const name = numberedName(item.name, n)
    const target = path.join(dir, name)
    try {
      if (isFolder) {
        // folders can't be hard linked: check, then move
        if (await exists(target)) continue
        await rename(from, target).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== 'EXDEV') throw e
          // another drive: copy, then remove
          await cp(from, target, { recursive: true, errorOnExist: true, force: false })
          await rm(from, { recursive: true, force: true })
        })
      } else {
        // a hard link fails if the name is taken, so nothing is ever overwritten
        await link(from, target)
        await unlink(from)
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      if (code !== 'EXDEV' || isFolder) throw e
      // a file on another drive than the trash: copy (never over another), then remove
      try {
        await copyFile(from, target, constants.COPYFILE_EXCL)
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw copyError
      }
      await unlink(from)
    }
    await unlink(path.join(INFO_DIR, `${id}.trashinfo`)).catch(() => {})
    const rel = item.folder ? `${item.folder}/${name}` : name
    console.log(`Restored ${target} from the trash`)
    return rel
  }
  throw new TrashError('No free name to restore it under')
}

/** Deletes the item for good (it can't be restored after this). Throws a TrashError the user can read */
export async function deleteFromTrash(id: string): Promise<void> {
  const item = await trashItem(id)
  if (!item) throw new TrashError('It is no longer in the trash')
  await rm(trashedFile(item), { recursive: true, force: true })
  await unlink(path.join(INFO_DIR, `${id}.trashinfo`)).catch(() => {})
  console.log(`Deleted ${item.path} from the trash for good`)
}
