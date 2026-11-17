// Deleting generated files, so they get rebuilt on next view.
//
// Stills and storyboards are named after a hash, so they can't be traced back
// to a folder. Instead, everything in the folder is walked and their names are
// recomputed with the current settings; previews are looked up by video /
// folder (server/previewNames.ts). (Files made with older settings are
// never used again anyway.)

import { readdir, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { cacheFile, cacheName, isRunning, tempFor } from '../cache.ts'
import { PREVIEW_DIR } from '../consts/previews.ts'
import { STORYBOARD_DIR } from '../consts/storyboards.ts'
import { THUMB_DIR } from '../consts/thumbnails.ts'
import { isVideoName } from '../listing.ts'
import { relativePath } from '../paths.ts'
import { existingPreviewFile, folderId, videoId } from '../previewNames.ts'
import { serverSettings } from '../settings.ts'
import { walk } from '../walk.ts'
import { videoInfo } from './probe.ts'
import * as storyboard from './storyboard.ts'
import * as thumbnail from './thumbnail.ts'

async function tryUnlink(file: string): Promise<boolean> {
  try {
    await unlink(file)
    return true
  } catch {
    return false
  }
}

/** Deletes one file and its half-written temp file; true if anything was removed */
async function remove(file: string): Promise<boolean> {
  const [a, b] = await Promise.all([tryUnlink(file), tryUnlink(tempFor(file))])
  return a || b
}

/** Removes the still, preview and storyboard of one video */
export async function purgeVideo(video: string): Promise<number> {
  const targets = [await cacheFile(THUMB_DIR, await cacheName(video, thumbnail.cacheSettings()), 'jpg')]
  // previews are named per video (server/previewNames.ts), not by a hash
  const clip = await existingPreviewFile(videoId(await relativePath(video)))
  if (clip) targets.push(clip)
  // the storyboard's name depends on the video's length and size
  const info = await videoInfo(video)
  const board = info && storyboard.plan(info)
  if (board) {
    targets.push(
      await cacheFile(
        STORYBOARD_DIR,
        await cacheName(video, storyboard.cacheSettings(board)),
        'jpg',
      ),
    )
  }
  const removed = await Promise.all(targets.map(remove))
  return removed.filter(Boolean).length
}

/** Removes every preview variant of one folder */
async function purgeFolderPreview(dir: string): Promise<number> {
  const rel = await relativePath(dir)
  let removed = 0
  for (let variant = 0; variant < serverSettings.folderPreviewVariants; variant++) {
    const clip = await existingPreviewFile(folderId(rel, variant))
    if (clip && (await remove(clip))) removed++
  }
  return removed
}

/**
 * Empties the whole cache at once: every still, preview (video and folder)
 * and storyboard, of every folder. Much faster than purgeFolder on the shared
 * folder, which walks every video. Files being built right now (and their
 * temp files) are left alone: their build would fail otherwise. The preview
 * names (PREVIEW_NAMES_FILE) are kept: they're outside the cache folders, and
 * a missing clip is simply built again under its name. Returns how many files
 * were deleted.
 */
export async function purgeAll(): Promise<number> {
  let removed = 0
  for (const dir of [THUMB_DIR, PREVIEW_DIR, STORYBOARD_DIR]) {
    const names = await readdir(dir).catch(() => [] as string[])
    const results = await Promise.all(
      names.map(async (name) => {
        const file = path.join(dir, name)
        // builds are keyed by their output file; a temp file belongs to one
        if (isRunning(file) || isRunning(file.replace(/\.tmp(\.\w+)$/, '$1'))) return false
        try {
          await rm(file, { recursive: true, force: true })
          return true
        } catch {
          return false
        }
      }),
    )
    removed += results.filter(Boolean).length
  }
  return removed
}

/**
 * Removes the generated files of `dir`, its subfolders and every video in
 * them; returns how many files were deleted
 */
export async function purgeFolder(dir: string): Promise<number> {
  const tree = await walk(dir)
  let removed = 0
  for (const d of tree.dirs) removed += await purgeFolderPreview(d)
  for (const file of tree.files) {
    if (isVideoName(path.basename(file))) removed += await purgeVideo(file)
  }
  return removed
}
