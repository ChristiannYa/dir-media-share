// Reading a folder into the entries the gallery shows.

import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './consts/fileTypes.ts'
import { FOLDER_PREVIEW_IMAGE_EXTENSIONS } from './consts/folderPreviews.ts'
import { UPLOAD_PART_SUFFIX } from './consts/uploads.ts'
import { favoritesIn, isFavorite } from './favorites.ts'
import { lastViewed } from './views.ts'
import { isMpegts, videoInfo } from './media/probe.ts'
import { resolveDir } from './paths.ts'
import { folderPlays, playCount } from './plays.ts'
import { Semaphore } from './semaphore.ts'
import { serverSettings } from './settings.ts'
import type { Entry, EntryKind } from './types.ts'

const PROBES = new Semaphore(() => serverSettings.probeMaxJobs)

/** True if the file name's extension (any case) is in `list` */
function hasExtension(name: string, list: readonly string[]): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return list.includes(ext)
}

/** True for file names with a VIDEO_EXTENSIONS extension */
export function isVideoName(name: string): boolean {
  return hasExtension(name, VIDEO_EXTENSIONS)
}

/** True for images a folder preview slideshow can use */
export function isSlideshowImageName(name: string): boolean {
  return hasExtension(name, FOLDER_PREVIEW_IMAGE_EXTENSIONS)
}

function kindOf(isDir: boolean, name: string): EntryKind {
  if (isDir) return 'folder'
  if (hasExtension(name, IMAGE_EXTENSIONS)) return 'image'
  if (isVideoName(name)) return 'video'
  return 'file'
}

async function readEntries(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch(() => [])
}

/**
 * When a file was added to this disk (ms since 1970): its creation time, or
 * its last change where the filesystem doesn't keep creation times
 */
export function addedTime(info: Stats): number {
  return Math.round(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs)
}

/** What a folder holds, counting its subfolders too */
interface FolderStats {
  size: number
  videos: number
  images: number
  /** When its newest video or image was added (ms since 1970); null if it has none */
  lastAdded: number | null
}

/**
 * Walks a folder recursively, adding up sizes, counting videos and images and
 * finding when the newest of them was added. Symlinked folders aren't
 * entered, so link loops can't hang the listing.
 */
async function scanDir(dir: string): Promise<FolderStats> {
  const stats: FolderStats = { size: 0, videos: 0, images: 0, lastAdded: null }
  const seen = (added: number | null) => {
    if (added !== null && (stats.lastAdded === null || added > stats.lastAdded)) {
      stats.lastAdded = added
    }
  }
  for (const entry of await readEntries(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await scanDir(full)
      stats.size += sub.size
      stats.videos += sub.videos
      stats.images += sub.images
      seen(sub.lastAdded)
    } else {
      const info = await stat(full).catch(() => null)
      stats.size += info?.size ?? 0
      const isVideo = isVideoName(entry.name)
      const isImage = !isVideo && hasExtension(entry.name, IMAGE_EXTENSIONS)
      if (isVideo) stats.videos++
      else if (isImage) stats.images++
      if ((isVideo || isImage) && info) seen(addedTime(info))
    }
  }
  return stats
}

/** True if the folder itself (not its subfolders) holds videos or images a folder preview can be made from */
async function hasOwnMedia(dir: string): Promise<boolean> {
  for (const entry of await readEntries(dir)) {
    if (entry.isDirectory()) continue
    if (isVideoName(entry.name) || isSlideshowImageName(entry.name)) return true
  }
  return false
}

/**
 * Options of a listing. `withVideoData`: include plays and "last viewed"
 * (false for a device in dev mode, server/appMode.ts: both come as null)
 */
export interface ListOptions {
  withVideoData: boolean
}

async function toEntry(
  dir: string,
  rel: string,
  name: string,
  { withVideoData }: ListOptions,
): Promise<Entry | null> {
  const full = path.join(dir, name)
  const info = await stat(full).catch(() => null) // follows symlinks
  if (!info) return null
  const kind = kindOf(info.isDirectory(), name)

  const entryPath = rel ? `${rel}/${name}` : name
  const entry: Entry = {
    name,
    kind,
    path: entryPath,
    size: info.size,
    duration: null,
    width: null,
    height: null,
    fps: null,
    needs_fix: false,
    has_preview: false,
    video_count: null,
    image_count: null,
    added: addedTime(info),
    last_added: null,
    last_viewed: kind === 'file' || !withVideoData ? null : lastViewed(entryPath),
    favorite: kind !== 'folder' && isFavorite(entryPath),
    favorite_count: kind === 'folder' ? favoritesIn(entryPath).length : null,
    plays: !withVideoData
      ? null
      : kind === 'video' || kind === 'image'
        ? playCount(entryPath)
        : kind === 'folder'
          ? folderPlays(entryPath)
          : null,
  }

  if (kind === 'folder') {
    const [stats, hasMedia] = await Promise.all([scanDir(full), hasOwnMedia(full)])
    entry.size = stats.size
    entry.video_count = stats.videos
    entry.image_count = stats.images
    entry.last_added = stats.lastAdded
    entry.has_preview = hasMedia
  } else if (kind === 'video') {
    const video = await PROBES.run(() => videoInfo(full))
    entry.duration = video?.duration ?? null
    // the size it plays at (non-square pixels applied), so the viewer's box has its shape
    entry.width = video?.displayWidth ?? null
    entry.height = video?.displayHeight ?? null
    entry.fps = video?.fps ?? null
    entry.needs_fix = video ? isMpegts(video) : false
  }
  return entry
}

/**
 * The entry of one file or folder, as its parent's listing would show it
 * (e.g. for the "Most played" section); null if it's gone
 */
export async function entryAt(rel: string, options: ListOptions): Promise<Entry | null> {
  const parentRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
  const dir = await resolveDir(parentRel)
  if (!dir) return null
  return toEntry(dir, parentRel, path.posix.basename(rel), options)
}

/** Lists `dir`, whose path relative to the shared folder is `rel` */
export async function list(dir: string, rel: string, options: ListOptions): Promise<Entry[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(
    (name) => !name.endsWith(UPLOAD_PART_SUFFIX), // uploads still in progress
  )
  const entries = await Promise.all(names.map((name) => toEntry(dir, rel, name, options)))
  return sort(entries.filter((e): e is Entry => e !== null))
}

function byName(a: Entry, b: Entry): number {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** Folders first (alphabetical), then videos by duration (longest first), then everything else (alphabetical) */
function sort(entries: Entry[]): Entry[] {
  const rank = (e: Entry) => (e.kind === 'folder' ? 0 : e.kind === 'video' ? 1 : 2)
  return entries.sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    if (a.kind === 'video') return (b.duration ?? 0) - (a.duration ?? 0)
    return byName(a, b)
  })
}
