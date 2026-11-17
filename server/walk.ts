// Folder walking, shared by folder previews, listings and cache clearing.

import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** Real path of `file` if it's a regular file (symlinks followed), else null */
async function realFile(file: string): Promise<string | null> {
  try {
    const real = await realpath(file)
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

/** Files directly inside `dir` (not in subfolders), canonicalized, sorted by path */
export async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[])
  const files = await Promise.all(entries.map((name) => realFile(path.join(dir, name))))
  return files.filter((f): f is string => f !== null).sort()
}

export interface Tree {
  /** The root and every folder below it */
  dirs: string[]
  /** Every file below the root, canonicalized, sorted by path */
  files: string[]
}

/**
 * Everything under `root`. Symlinked folders are not followed, so a link loop
 * can't make this run forever. Files are canonicalized so they match the paths
 * the handlers hash for cache names.
 */
export async function walk(root: string): Promise<Tree> {
  const dirs: string[] = []
  const files: string[] = []
  const pending = [root]

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (!entries) continue
    dirs.push(current)
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
      } else {
        const real = await realFile(full)
        if (real) files.push(real)
      }
    }
  }

  files.sort()
  return { dirs, files }
}
