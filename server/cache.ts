// File names for generated stills, previews and storyboards in the cache
// folder (CACHE_ROOT in consts/caching.ts, usually ~/.cache/med).

import { createHash } from 'node:crypto'
import { access, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** Last modification time in seconds (0 if unknown) */
export async function mtimeSecs(file: string): Promise<number> {
  try {
    return Math.floor((await stat(file)).mtimeMs / 1000)
  } catch {
    return 0
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Stable name for something generated from `source`. Changes when the source
 * is modified or when `settings` change, so stale results are never reused.
 */
export async function cacheName(source: string, settings: unknown): Promise<string> {
  const key = JSON.stringify([source, await mtimeSecs(source), settings])
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** `dir/name.ext`, creating `dir` if needed */
export async function cacheFile(dir: string, name: string, ext: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return path.join(dir, `${name}.${ext}`)
}

/** Where to write before renaming to `out`, so half-written files are never served */
export function tempFor(out: string): string {
  const ext = path.extname(out)
  return `${out.slice(0, out.length - ext.length)}.tmp${ext}`
}

/**
 * URL of a cached file, with its modification time appended so the browser
 * fetches it again whenever it's rebuilt (e.g. after clearing the cache)
 */
export async function versionedUrl(
  route: string,
  file: string,
  name: string,
  ext: string,
): Promise<string> {
  // preview names hold folder names, which can have any character
  return `${route}/${encodeURIComponent(name)}.${ext}?v=${await mtimeSecs(file)}`
}

const inflight = new Map<string, Promise<void>>()

/**
 * Runs `task` once per key at a time: requests that arrive while it's running
 * wait for the same run instead of building the same file twice.
 */
export function once(key: string, task: () => Promise<void>): Promise<void> {
  const running = inflight.get(key)
  if (running) return running
  const promise = task().finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

/** True while a `once` task for `key` is running */
export function isRunning(key: string): boolean {
  return inflight.has(key)
}
