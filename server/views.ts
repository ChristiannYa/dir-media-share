// "Last viewed": when each video was last played in the viewer, or each photo
// shown there, and each folder holding it (at any depth, like a folder's "last
// added"). Only that counts, not a preview in the grid or just looking at a
// folder.
// Kept by the path the listing shows, in VIEWS_FILE, so every device sees the
// same. Moving or renaming keeps them; trashing a file drops its own.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { VIEWS_FILE } from './consts/server.ts'

function load(): Map<string, number> {
  try {
    const saved: unknown = JSON.parse(readFileSync(VIEWS_FILE, 'utf8'))
    if (typeof saved !== 'object' || saved === null) return new Map()
    return new Map(
      Object.entries(saved).filter((e): e is [string, number] => typeof e[1] === 'number'),
    )
  } catch {
    return new Map() // no file yet (or unreadable): nothing viewed
  }
}

const views = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const json = JSON.stringify(Object.fromEntries([...views].sort()), null, 2) + '\n'
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(VIEWS_FILE), { recursive: true })
    const tmp = `${VIEWS_FILE}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, VIEWS_FILE)
  })
  return saving
}

/** When the video or folder at `rel` was last viewed (ms since 1970), or null if never */
export function lastViewed(rel: string): number | null {
  return views.get(rel) ?? null
}

/**
 * Everything inside the folder `folderRel` (subfolders included; files and
 * folders alike, the handler keeps the kind it wants) that was viewed, as
 * [path, time], the latest first (the "Recently viewed" section)
 */
export function recentlyViewedIn(folderRel: string): Array<[string, number]> {
  const prefix = folderRel ? `${folderRel}/` : ''
  return [...views]
    .filter(([rel]) => rel.startsWith(prefix))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** The same for what sits directly inside `folderRel` (its files and subfolders) */
export function recentlyViewedFolders(folderRel: string): Array<[string, number]> {
  const prefix = folderRel ? `${folderRel}/` : ''
  return recentlyViewedIn(folderRel).filter(([rel]) => !rel.slice(prefix.length).includes('/'))
}

/** The video / photo at `rel` was just played / shown: it and every folder above it were viewed now */
export async function markViewed(rel: string): Promise<number> {
  const now = Date.now()
  const parts = rel.split('/')
  for (let i = parts.length; i > 0; i--) views.set(parts.slice(0, i).join('/'), now)
  await save()
  return now
}

/**
 * Files or folders were moved / renamed ([from, to] pairs, all at once): their
 * times go with them, and a folder's those of everything inside it
 */
export async function moveViews(moves: Array<[string, string]>): Promise<void> {
  const moved: Array<[string, number]> = []
  for (const [from, to] of moves) {
    for (const [rel, at] of views) {
      if (rel !== from && !rel.startsWith(from + '/')) continue
      views.delete(rel)
      moved.push([to + rel.slice(from.length), at])
    }
  }
  if (moved.length === 0) return
  for (const [rel, at] of moved) views.set(rel, at)
  await save()
}

/** A file was trashed: its own time goes (its folders keep theirs) */
export async function forgetView(rel: string): Promise<void> {
  if (views.delete(rel)) await save()
}
