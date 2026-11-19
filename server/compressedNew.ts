// Compressed / edited copies not opened yet: each copy the compress queue
// saves (server/compressQueue.ts) is added, by its path inside the shared
// folder, and its card shows the "Compressed!" / "Edited!" badges until it's
// opened in the viewer (POST ROUTE_COMPRESS_SEEN). Saved in
// COMPRESSED_NEW_FILE, so every device sees the same. Moving or renaming the
// copy keeps it; trashing drops it (see handlers/files.ts).
//
// What was done to each (edited, compressed) is kept with it: a file that
// replaced its original has the original's name, so its name can't tell.
// Older saves have paths only: the client tells those from their names.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { COMPRESSED_NEW_FILE } from './consts/server.ts'

/** What was done to a new copy; null: not known (saved before this was kept) */
export type NewKind = { edited: boolean; compressed: boolean } | null

function isKind(value: unknown): value is { edited: boolean; compressed: boolean } {
  const k = value as { edited?: unknown; compressed?: unknown } | null
  return !!k && typeof k.edited === 'boolean' && typeof k.compressed === 'boolean'
}

function load(): Map<string, NewKind> {
  const map = new Map<string, NewKind>()
  try {
    const saved: unknown = JSON.parse(readFileSync(COMPRESSED_NEW_FILE, 'utf8'))
    if (!Array.isArray(saved)) return map
    for (const item of saved) {
      // older saves: the path alone
      if (typeof item === 'string') map.set(item, null)
      else if (item && typeof item.path === 'string') {
        map.set(item.path, isKind(item) ? { edited: item.edited, compressed: item.compressed } : null)
      }
    }
  } catch {
    // no file yet (or unreadable): none
  }
  return map
}

const unseen = load()

/** Saves run one after another, so a quick second change can't be overwritten by the first */
let saving: Promise<void> = Promise.resolve()

function save(): Promise<void> {
  const list = [...unseen]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, kind]) => (kind ? { path: rel, ...kind } : rel))
  saving = saving.then(async () => {
    // write a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(path.dirname(COMPRESSED_NEW_FILE), { recursive: true })
    const tmp = `${COMPRESSED_NEW_FILE}.tmp`
    await writeFile(tmp, JSON.stringify(list, null, 2) + '\n')
    await rename(tmp, COMPRESSED_NEW_FILE)
  })
  return saving
}

/** True if `rel` is a compressed / edited copy that wasn't opened yet */
export function isCompressedNew(rel: string): boolean {
  return unseen.has(rel)
}

/** What was done to the new copy `rel` (null: not new, or not known) */
export function newKindOf(rel: string): NewKind {
  return unseen.get(rel) ?? null
}

/**
 * How many compressed copies not opened yet are directly inside the folder
 * `folderRel` ('' = the shared folder): only its direct children, not what's in
 * its subfolders, so the count is on the folder that holds the copies
 */
export function compressedNewIn(folderRel: string): number {
  const prefix = folderRel ? `${folderRel}/` : ''
  let count = 0
  for (const rel of unseen.keys()) {
    if (rel.startsWith(prefix) && !rel.slice(prefix.length).includes('/')) count++
  }
  return count
}

/** The queue just saved `rel` (a copy, or a file that replaced its original): it gets the badges of `kind` */
export async function markCompressedNew(rel: string, kind: NewKind = null): Promise<void> {
  const before = unseen.get(rel)
  if (unseen.has(rel) && JSON.stringify(before) === JSON.stringify(kind)) return
  unseen.set(rel, kind)
  await save()
}

/** `rel` was opened (or deleted): no badge any more. False if it had none */
export async function setCompressedSeen(rel: string): Promise<boolean> {
  if (!unseen.delete(rel)) return false
  await save()
  return true
}

/** Files moved or renamed (`moves`: [from, to] pairs): their badges follow them */
export async function moveCompressedNew(moves: Array<[string, string]>): Promise<void> {
  const marked = moves.filter(([from]) => unseen.has(from))
  if (marked.length === 0) return
  const kinds = marked.map(([from]) => unseen.get(from) ?? null)
  for (const [from] of marked) unseen.delete(from)
  marked.forEach(([, to], i) => unseen.set(to, kinds[i] ?? null))
  await save()
}

/**
 * A file or folder was renamed from `from` to `to`: its badge, and those of
 * everything inside it, go with it
 */
export async function renameCompressedNew(from: string, to: string): Promise<void> {
  let changed = false
  for (const [rel, kind] of [...unseen]) {
    if (rel !== from && !rel.startsWith(from + '/')) continue
    unseen.delete(rel)
    unseen.set(to + rel.slice(from.length), kind)
    changed = true
  }
  if (changed) await save()
}
