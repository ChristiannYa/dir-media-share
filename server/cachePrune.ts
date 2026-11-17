// Keeps the cache (stills, previews, storyboards) under the "Cache size limit"
// setting: once a minute, if it's over, the files used longest ago are
// deleted until it's back under. They're built again if needed.
//
// Files made with old settings, or for videos that were edited, moved or
// deleted, are never used again; this is what clears them out.

import { readdir, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isRunning } from './cache.ts'
import {
  CACHE_KEEP_RECENT_MS,
  CACHE_PRUNE_INTERVAL_MS,
  CACHE_PRUNE_TARGET,
  LEGACY_CACHE_DIRS,
} from './consts/caching.ts'
import { PREVIEW_DIR } from './consts/previews.ts'
import { STORYBOARD_DIR } from './consts/storyboards.ts'
import { THUMB_DIR } from './consts/thumbnails.ts'
import { serverSettings } from './settings.ts'

const DIRS = [THUMB_DIR, PREVIEW_DIR, STORYBOARD_DIR]

interface CachedFile {
  file: string
  size: number
  /** Last read or written (ms) */
  usedAt: number
}

async function listFiles(dir: string): Promise<CachedFile[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const files: CachedFile[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    // atime: when it was last served (Linux refreshes it at least daily)
    files.push({ file, size: info.size, usedAt: Math.max(info.atimeMs, info.mtimeMs) })
  }
  return files
}

/** True while a file must not be deleted: being built (or its temp file), or used just now */
function inUse(f: CachedFile, now: number): boolean {
  if (now - f.usedAt < CACHE_KEEP_RECENT_MS) return true
  // builds are keyed by their output file; a temp file belongs to one
  return isRunning(f.file) || isRunning(f.file.replace(/\.tmp(\.\w+)$/, '$1'))
}

let pruning = false

/** Deletes the files used longest ago while the cache is over the limit */
export async function pruneCache(): Promise<void> {
  if (pruning) return
  pruning = true
  try {
    const limit = serverSettings.cacheMaxGB * 1024 ** 3
    const files = (await Promise.all(DIRS.map(listFiles))).flat()
    let total = files.reduce((sum, f) => sum + f.size, 0)
    if (total <= limit) return

    const target = limit * CACHE_PRUNE_TARGET
    const now = Date.now()
    let removed = 0
    let freed = 0
    for (const f of files.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= target) break
      if (inUse(f, now)) continue
      try {
        await unlink(f.file)
        total -= f.size
        freed += f.size
        removed++
      } catch {
        // gone already, or not ours to delete: skip it
      }
    }
    console.log(
      `Cache over ${serverSettings.cacheMaxGB} GB: removed ${removed} old files ` +
        `(${(freed / 1024 ** 3).toFixed(2)} GB), now ${(total / 1024 ** 3).toFixed(2)} GB`,
    )
  } catch (e) {
    console.error('Cleaning the cache failed:', e)
  } finally {
    pruning = false
  }
}

/**
 * Which server settings each cache folder's files are made with (they're in
 * the files' names, see each media module's cacheSettings): changing one makes
 * every file in that folder unusable
 */
const MADE_WITH: Array<{ dir: string; what: string; keys: string[] }> = [
  {
    dir: PREVIEW_DIR,
    what: 'previews',
    keys: [
      'previewClips',
      'previewSecs',
      'previewWidth',
      'previewCrf',
      'previewPreset',
      'scaleFlags',
      'folderPreviewItems',
      'folderPreviewSlicesPerVideo',
    ],
  },
  {
    dir: THUMB_DIR,
    what: 'stills',
    keys: ['thumbWidth', 'thumbQuality', 'thumbSampleFrames', 'scaleFlags'],
  },
  {
    dir: STORYBOARD_DIR,
    what: 'storyboards',
    keys: [
      'storyboardTileWidth',
      'storyboardColumns',
      'storyboardMaxTiles',
      'storyboardMinInterval',
      'storyboardQuality',
    ],
  },
]

/**
 * After server settings changed (`changed`: their keys): deletes the cached
 * files those settings made unusable, right away instead of waiting for the
 * size limit. Only the folders they affect: a new preview width leaves stills
 * and storyboards alone, and settings that change no file (encodes at once,
 * browser cache…) delete nothing. Files still being built are left; they're
 * cleared by the size limit later. Returns how many were deleted.
 */
export async function clearObsoleteCache(changed: string[]): Promise<number> {
  let removed = 0
  for (const { dir, what, keys } of MADE_WITH) {
    if (!changed.some((k) => keys.includes(k))) continue
    let count = 0
    let freed = 0
    for (const f of await listFiles(dir)) {
      if (isRunning(f.file) || isRunning(f.file.replace(/\.tmp(\.\w+)$/, '$1'))) continue
      try {
        await unlink(f.file)
        count++
        freed += f.size
      } catch {
        // gone already: fine
      }
    }
    if (count) {
      console.log(
        `Settings changed: removed ${count} old ${what} (${(freed / 1024 ** 3).toFixed(2)} GB)`,
      )
    }
    removed += count
  }
  return removed
}

/** Empties the /tmp cache folders of older versions, giving their RAM back */
async function removeLegacyCache() {
  for (const dir of LEGACY_CACHE_DIRS) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (e) {
      console.error(`Removing the old cache ${dir} failed:`, e)
    }
  }
}

/**
 * Deletes previews still named after a hash ("3f9a1c0b7e2d4a51.mp4"), from
 * before they were named after their folder (server/previewNames.ts): nothing
 * asks for them any more
 */
async function removeHashNamedPreviews() {
  const names = await readdir(PREVIEW_DIR).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!/^[0-9a-f]{16}(\.tmp)?\.mp4$/.test(name)) continue
    if (await unlink(path.join(PREVIEW_DIR, name)).then(() => true, () => false)) removed++
  }
  if (removed) console.log(`Removed ${removed} previews with old (hash) names`)
}

let started = false

/** Cleans up once now, then checks the size every CACHE_PRUNE_INTERVAL_MS */
export function startCachePruning() {
  if (started) return
  started = true
  void removeLegacyCache().then(removeHashNamedPreviews).then(pruneCache)
  // unref: this timer alone doesn't keep the server running
  setInterval(() => void pruneCache(), CACHE_PRUNE_INTERVAL_MS).unref()
}
