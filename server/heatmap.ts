// "Most watched parts" of each video, like YouTube's heatmap over the seek
// bar: the video is cut into HEATMAP_BINS equal parts, and each part counts
// how many times it was watched in the viewer (played through, not skipped
// over). Watching a part again (seeking back, a loop) counts again.
// Kept by the path the listing shows, in HEATMAP_FILE, so every device sees
// the same. Moving or renaming keeps them; trashing a file drops its own.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HEATMAP_BINS } from './consts/heatmap.ts'
import { HEATMAP_FILE } from './consts/server.ts'

function isCounts(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === HEATMAP_BINS &&
    value.every((n) => Number.isInteger(n) && n >= 0)
  )
}

function load(): Map<string, number[]> {
  try {
    const saved: unknown = JSON.parse(readFileSync(HEATMAP_FILE, 'utf8'))
    if (typeof saved !== 'object' || saved === null) return new Map()
    // a different number of parts (HEATMAP_BINS changed): those are dropped
    return new Map(Object.entries(saved).filter((e): e is [string, number[]] => isCounts(e[1])))
  } catch {
    return new Map() // no file yet (or unreadable): nothing watched
  }
}

const heatmaps = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  // one line per video: the file stays readable without being huge
  const lines = [...heatmaps]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([rel, counts]) => `  ${JSON.stringify(rel)}: ${JSON.stringify(counts)}`)
  const json = lines.length ? `{\n${lines.join(',\n')}\n}\n` : '{}\n'
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(HEATMAP_FILE), { recursive: true })
    const tmp = `${HEATMAP_FILE}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, HEATMAP_FILE)
  })
  return saving
}

/** How many times each part of the video at `rel` was watched, or null if never */
export function heatmapOf(rel: string): number[] | null {
  return heatmaps.get(rel) ?? null
}

/**
 * Adds `counts` (one number per part: how many times it was just watched) to
 * the video at `rel`. Throws if it isn't HEATMAP_BINS whole numbers ≥ 0.
 */
export async function addWatched(rel: string, counts: unknown): Promise<number[]> {
  if (!isCounts(counts)) throw new TypeError('bad counts')
  const sum = heatmaps.get(rel)?.slice() ?? new Array<number>(HEATMAP_BINS).fill(0)
  let changed = false
  for (let i = 0; i < HEATMAP_BINS; i++) {
    const n = counts[i] ?? 0
    if (n > 0) {
      sum[i] = (sum[i] ?? 0) + n
      changed = true
    }
  }
  if (!changed) return sum
  heatmaps.set(rel, sum)
  await save()
  return sum
}

/**
 * Files or folders were moved / renamed ([from, to] pairs, all at once): their
 * heatmaps go with them, and a folder's those of everything inside it
 */
export async function moveHeatmaps(moves: Array<[string, string]>): Promise<void> {
  const moved: Array<[string, number[]]> = []
  for (const [from, to] of moves) {
    for (const [rel, counts] of heatmaps) {
      if (rel !== from && !rel.startsWith(from + '/')) continue
      heatmaps.delete(rel)
      moved.push([to + rel.slice(from.length), counts])
    }
  }
  if (moved.length === 0) return
  for (const [rel, counts] of moved) heatmaps.set(rel, counts)
  await save()
}

/** A file was trashed: its heatmap goes */
export async function forgetHeatmap(rel: string): Promise<void> {
  if (heatmaps.delete(rel)) await save()
}
