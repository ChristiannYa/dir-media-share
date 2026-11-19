// Time watched: how long each video was played in the viewer, or each photo
// shown there, all openings added up (ms). Only openings that counted as a
// view, and only time actually watched (src/App.vue reports it: playback
// moving forward for a video, the photo on screen with the tab visible),
// including the seconds that made the view. Folders show the sum of what's
// inside.
// Kept by the path the listing shows, in WATCH_TIME_FILE, so every device sees
// the same. Moving or renaming keeps it; trashing a file drops its own.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WATCH_TIME_FILE } from './consts/server.ts'

function load(): Map<string, number> {
  try {
    const saved: unknown = JSON.parse(readFileSync(WATCH_TIME_FILE, 'utf8'))
    if (typeof saved !== 'object' || saved === null) return new Map()
    return new Map(
      Object.entries(saved).filter(
        (e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0,
      ),
    )
  } catch {
    return new Map() // no file yet (or unreadable): nothing watched
  }
}

const watched = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const json = JSON.stringify(Object.fromEntries([...watched].sort()), null, 2) + '\n'
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(WATCH_TIME_FILE), { recursive: true })
    const tmp = `${WATCH_TIME_FILE}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, WATCH_TIME_FILE)
  })
  return saving
}

/** How long the video / photo at `rel` was watched / shown (ms; 0 if never) */
export function watchTime(rel: string): number {
  return watched.get(rel) ?? 0
}

/** The video / photo at `rel` was just watched / shown for `ms` more. Returns the new total */
export async function addWatchTime(rel: string, ms: number): Promise<number> {
  const total = watchTime(rel) + ms
  watched.set(rel, total)
  await save()
  return total
}

/** Sets the time watched of the video / photo at `rel` by hand (the metadata dialog); 0 forgets it */
export async function setWatchTime(rel: string, ms: number): Promise<void> {
  if (ms === watchTime(rel)) return
  if (ms > 0) watched.set(rel, ms)
  else watched.delete(rel)
  await save()
}

/** Longest first; equal: by path */
function byMost(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
}

/**
 * The files inside the folder `folderRel` (subfolders included) that were
 * watched at all, longest watched first (the "Most watch time" section)
 */
export function mostWatchedIn(folderRel: string): Array<[string, number]> {
  const prefix = folderRel ? `${folderRel}/` : ''
  return [...watched].filter(([rel]) => rel.startsWith(prefix)).sort(byMost)
}

/**
 * The folders directly inside `folderRel` with time watched inside them (at
 * any depth), as [path, sum], longest watched first
 */
export function mostWatchedFolders(folderRel: string): Array<[string, number]> {
  const prefix = folderRel ? `${folderRel}/` : ''
  const sums = new Map<string, number>()
  for (const [rel, ms] of watched) {
    if (!rel.startsWith(prefix)) continue
    const rest = rel.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) continue // a file directly in the folder, not in a subfolder
    const sub = prefix + rest.slice(0, slash)
    sums.set(sub, (sums.get(sub) ?? 0) + ms)
  }
  return [...sums].sort(byMost)
}

/** Time watched of everything inside the folder `folderRel` (subfolders included) */
export function folderWatchTime(folderRel: string): number {
  const prefix = folderRel ? `${folderRel}/` : ''
  let sum = 0
  for (const [rel, ms] of watched) if (rel.startsWith(prefix)) sum += ms
  return sum
}

/**
 * Files or folders were moved / renamed ([from, to] pairs, all at once): their
 * times go with them, and a folder's those of everything inside it
 */
export async function moveWatchTime(moves: Array<[string, string]>): Promise<void> {
  const moved: Array<[string, number]> = []
  for (const [from, to] of moves) {
    for (const [rel, ms] of watched) {
      if (rel !== from && !rel.startsWith(from + '/')) continue
      watched.delete(rel)
      moved.push([to + rel.slice(from.length), ms])
    }
  }
  if (moved.length === 0) return
  for (const [rel, ms] of moved) watched.set(rel, ms)
  await save()
}

/** A file was trashed: its time goes */
export async function forgetWatchTime(rel: string): Promise<void> {
  if (watched.delete(rel)) await save()
}
