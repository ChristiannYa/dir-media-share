// The cache version shared by every device: a number that goes up each time a
// cache is cleared (a folder's, or all of it). The pages put it in the URLs of
// the stills, so after a clear every browser fetches fresh ones instead of
// showing its own cached copies. Sent with /api/info when a page loads, and
// pushed to the pages already open on the job events stream. Saved in
// CACHE_VERSION_FILE, so it keeps going up across restarts (a version a
// browser already cached must never come back).

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CACHE_VERSION_FILE } from './consts/server.ts'
import { emitCacheCleared } from './jobEvents.ts'

function load(): number {
  try {
    const saved = Number(JSON.parse(readFileSync(CACHE_VERSION_FILE, 'utf8')))
    return Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0
  } catch {
    return 0 // no file yet (or unreadable): nothing cleared yet
  }
}

let version = load()

/** Saves run one after another, so a quick second clear can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

/** The current shared cache version */
export function cacheVersion(): number {
  return version
}

/**
 * A cache was just cleared: one version up, saved, and announced to every
 * open page. Returns the new version
 */
export async function bumpCacheVersion(): Promise<number> {
  const next = ++version
  saving = saving
    .catch(() => {})
    .then(async () => {
      // write a temp file, then rename: a crash mid-write can't leave half a file
      await mkdir(path.dirname(CACHE_VERSION_FILE), { recursive: true })
      const tmp = `${CACHE_VERSION_FILE}.tmp`
      await writeFile(tmp, `${next}\n`)
      await rename(tmp, CACHE_VERSION_FILE)
    })
  try {
    await saving
  } catch (e) {
    // still announced: the open pages refresh, only a restart would forget it
    console.error('Saving the cache version failed:', e)
  }
  emitCacheCleared(next)
  return next
}
