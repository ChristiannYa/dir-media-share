// Favorites: the videos and photos marked with the heart, by their path inside
// the shared folder. Saved in FAVORITES_FILE, so every device sees the same.
// Moving or renaming a file keeps its heart; trashing it drops it (see handlers/files.ts).

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FAVORITES_FILE } from './consts/server.ts'

function load(): Set<string> {
  try {
    const saved: unknown = JSON.parse(readFileSync(FAVORITES_FILE, 'utf8'))
    return new Set(Array.isArray(saved) ? saved.filter((p) => typeof p === 'string') : [])
  } catch {
    return new Set() // no file yet (or unreadable): no favorites
  }
}

const favorites = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const list = [...favorites].sort()
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(FAVORITES_FILE), { recursive: true })
    const tmp = `${FAVORITES_FILE}.tmp`
    await writeFile(tmp, JSON.stringify(list, null, 2) + '\n')
    await rename(tmp, FAVORITES_FILE)
  })
  return saving
}

/** True if the file at `rel` (path inside the shared folder) has the heart */
export function isFavorite(rel: string): boolean {
  return favorites.has(rel)
}

/** Adds or removes the heart of `rel` and saves */
export async function setFavorite(rel: string, on: boolean): Promise<void> {
  if (on === favorites.has(rel)) return
  if (on) favorites.add(rel)
  else favorites.delete(rel)
  await save()
}

/** A favorite moved from `from` to `to`: its heart goes with it */
export async function moveFavorite(from: string, to: string): Promise<void> {
  if (!favorites.delete(from)) return
  favorites.add(to)
  await save()
}

/**
 * Several files were renamed at once (`moves`: [from, to] pairs): their
 * hearts follow them, even when one takes the name another one left
 */
export async function moveFavorites(moves: Array<[string, string]>): Promise<void> {
  const hearted = moves.filter(([from]) => favorites.has(from))
  if (hearted.length === 0) return
  for (const [from] of hearted) favorites.delete(from)
  for (const [, to] of hearted) favorites.add(to)
  await save()
}

/**
 * A file or folder was renamed from `from` to `to`: its heart, and the hearts
 * of everything inside it, go with it
 */
export async function renameFavorites(from: string, to: string): Promise<void> {
  let changed = false
  for (const rel of [...favorites]) {
    if (rel !== from && !rel.startsWith(from + '/')) continue
    favorites.delete(rel)
    favorites.add(to + rel.slice(from.length))
    changed = true
  }
  if (changed) await save()
}
