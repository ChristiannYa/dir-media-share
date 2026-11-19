// Play counts: how many times each video was played in the viewer, or each
// photo shown there (counted at the same moments as "last viewed",
// server/views.ts). The "Most played" section of the folders in .bin and their
// subfolders lists the highest ones (handlers/mostPlayed.ts).
// Kept by the path the listing shows, in PLAYS_FILE, so every device sees the
// same. Moving or renaming keeps them; trashing a file drops its own.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PLAYS_FILE } from './consts/server.ts'

function load(): Map<string, number> {
  try {
    const saved: unknown = JSON.parse(readFileSync(PLAYS_FILE, 'utf8'))
    if (typeof saved !== 'object' || saved === null) return new Map()
    return new Map(
      Object.entries(saved).filter(
        (e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0,
      ),
    )
  } catch {
    return new Map() // no file yet (or unreadable): nothing played
  }
}

const plays = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const json = JSON.stringify(Object.fromEntries([...plays].sort()), null, 2) + '\n'
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(PLAYS_FILE), { recursive: true })
    const tmp = `${PLAYS_FILE}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, PLAYS_FILE)
  })
  return saving
}

/** How many times the video / photo at `rel` was played / shown (0 if never) */
export function playCount(rel: string): number {
  return plays.get(rel) ?? 0
}

/** The video / photo at `rel` was just played / shown: one more. Returns the new count */
export async function countPlay(rel: string): Promise<number> {
  const count = playCount(rel) + 1
  plays.set(rel, count)
  await save()
  return count
}

/**
 * The files inside the folder `folderRel` (subfolders included) that were
 * played at least once, most played first (equal counts: by path)
 */
export function mostPlayedIn(folderRel: string): Array<[string, number]> {
  const prefix = folderRel ? `${folderRel}/` : ''
  return [...plays]
    .filter(([rel]) => rel.startsWith(prefix))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** Sets the count of the video / photo at `rel` by hand (the metadata dialog); 0 forgets it */
export async function setPlayCount(rel: string, count: number): Promise<void> {
  if (count === playCount(rel)) return
  if (count > 0) plays.set(rel, count)
  else plays.delete(rel)
  await save()
}

/** Plays of everything inside the folder `folderRel` (subfolders included) */
export function folderPlays(folderRel: string): number {
  const prefix = folderRel ? `${folderRel}/` : ''
  let sum = 0
  for (const [rel, count] of plays) if (rel.startsWith(prefix)) sum += count
  return sum
}

/**
 * The folders directly inside `folderRel` with plays inside them (at any
 * depth), as [path, sum of plays], most played first (equal: by path)
 */
export function mostPlayedFolders(folderRel: string): Array<[string, number]> {
  const prefix = folderRel ? `${folderRel}/` : ''
  const sums = new Map<string, number>()
  for (const [rel, count] of plays) {
    if (!rel.startsWith(prefix)) continue
    const rest = rel.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) continue // a file directly in the folder, not in a subfolder
    const sub = prefix + rest.slice(0, slash)
    sums.set(sub, (sums.get(sub) ?? 0) + count)
  }
  return [...sums].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * Files or folders were moved / renamed ([from, to] pairs, all at once): their
 * counts go with them, and a folder's those of everything inside it
 */
export async function movePlays(moves: Array<[string, string]>): Promise<void> {
  const moved: Array<[string, number]> = []
  for (const [from, to] of moves) {
    for (const [rel, count] of plays) {
      if (rel !== from && !rel.startsWith(from + '/')) continue
      plays.delete(rel)
      moved.push([to + rel.slice(from.length), count])
    }
  }
  if (moved.length === 0) return
  for (const [rel, count] of moved) plays.set(rel, count)
  await save()
}

/** A file was trashed: its count goes */
export async function forgetPlays(rel: string): Promise<void> {
  if (plays.delete(rel)) await save()
}
