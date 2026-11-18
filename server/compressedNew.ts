// Compressed copies not opened yet: each copy the compress queue saves
// (server/compressQueue.ts) is added, by its path inside the shared folder,
// and its card shows the "Compressed!" banner until it's opened in the viewer
// (POST ROUTE_COMPRESS_SEEN). Saved in COMPRESSED_NEW_FILE, so every device
// sees the same. Moving or renaming the copy keeps it; trashing drops it (see
// handlers/files.ts).

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { COMPRESSED_NEW_FILE } from './consts/server.ts'

function load(): Set<string> {
  try {
    const saved: unknown = JSON.parse(readFileSync(COMPRESSED_NEW_FILE, 'utf8'))
    return new Set(Array.isArray(saved) ? saved.filter((p) => typeof p === 'string') : [])
  } catch {
    return new Set() // no file yet (or unreadable): none
  }
}

const unseen = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const list = [...unseen].sort()
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(COMPRESSED_NEW_FILE), { recursive: true })
    const tmp = `${COMPRESSED_NEW_FILE}.tmp`
    await writeFile(tmp, JSON.stringify(list, null, 2) + '\n')
    await rename(tmp, COMPRESSED_NEW_FILE)
  })
  return saving
}

/** True if `rel` is a compressed copy that wasn't opened yet */
export function isCompressedNew(rel: string): boolean {
  return unseen.has(rel)
}

/** A compression just saved the copy `rel`: it gets the banner */
export async function markCompressedNew(rel: string): Promise<void> {
  if (unseen.has(rel)) return
  unseen.add(rel)
  await save()
}

/** `rel` was opened (or deleted): no banner any more. False if it had none */
export async function setCompressedSeen(rel: string): Promise<boolean> {
  if (!unseen.delete(rel)) return false
  await save()
  return true
}

/** Files moved or renamed (`moves`: [from, to] pairs): their banners follow them */
export async function moveCompressedNew(moves: Array<[string, string]>): Promise<void> {
  const marked = moves.filter(([from]) => unseen.has(from))
  if (marked.length === 0) return
  for (const [from] of marked) unseen.delete(from)
  for (const [, to] of marked) unseen.add(to)
  await save()
}

/**
 * A file or folder was renamed from `from` to `to`: its banner, and those of
 * everything inside it, go with it
 */
export async function renameCompressedNew(from: string, to: string): Promise<void> {
  let changed = false
  for (const rel of [...unseen]) {
    if (rel !== from && !rel.startsWith(from + '/')) continue
    unseen.delete(rel)
    unseen.add(to + rel.slice(from.length))
    changed = true
  }
  if (changed) await save()
}
