// View log: every moment a video / photo counted as a view (the "+1", the same
// moment "last viewed" and the play count go up, handlers/files.ts), as ms
// since 1970, oldest first. Shown in the file menu's mini section under
// "Added" (src/components/CardMenu.vue). Views counted before this log existed
// have no date here, so it can hold fewer dates than the play count.
// Kept by the path the listing shows, in VIEW_LOG_FILE, so every device sees
// the same. Moving or renaming keeps it; trashing a file, or setting its views
// to 0, drops it.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { VIEW_LOG_FILE } from './consts/server.ts'

function load(): Map<string, number[]> {
  try {
    const saved: unknown = JSON.parse(readFileSync(VIEW_LOG_FILE, 'utf8'))
    if (typeof saved !== 'object' || saved === null) return new Map()
    const map = new Map<string, number[]>()
    for (const [rel, list] of Object.entries(saved)) {
      if (!Array.isArray(list)) continue
      const dates = list.filter((n): n is number => typeof n === 'number')
      if (dates.length > 0) map.set(rel, dates)
    }
    return map
  } catch {
    return new Map() // no file yet (or unreadable): no views logged
  }
}

const log = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  // one line per file: the file stays readable without being huge
  const lines = [...log]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([rel, dates]) => `  ${JSON.stringify(rel)}: ${JSON.stringify(dates)}`)
  const json = lines.length > 0 ? `{\n${lines.join(',\n')}\n}\n` : '{}\n'
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(VIEW_LOG_FILE), { recursive: true })
    const tmp = `${VIEW_LOG_FILE}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, VIEW_LOG_FILE)
  })
  return saving
}

/** When the video / photo at `rel` counted as a view, newest first (empty if never logged) */
export function viewLogOf(rel: string): number[] {
  return [...(log.get(rel) ?? [])].reverse()
}

/** The video / photo at `rel` just counted as a view, at `at` (ms since 1970) */
export async function addViewLog(rel: string, at: number): Promise<void> {
  const dates = log.get(rel)
  if (dates) dates.push(at)
  else log.set(rel, [at])
  await save()
}

/**
 * Files or folders were moved / renamed ([from, to] pairs, all at once): their
 * logs go with them, and a folder's those of everything inside it
 */
export async function moveViewLog(moves: Array<[string, string]>): Promise<void> {
  const moved: Array<[string, number[]]> = []
  for (const [from, to] of moves) {
    for (const [rel, dates] of log) {
      if (rel !== from && !rel.startsWith(from + '/')) continue
      log.delete(rel)
      moved.push([to + rel.slice(from.length), dates])
    }
  }
  if (moved.length === 0) return
  for (const [rel, dates] of moved) log.set(rel, dates)
  await save()
}

/** A file was trashed, or its views set to 0: its log goes */
export async function forgetViewLog(rel: string): Promise<void> {
  if (log.delete(rel)) await save()
}
