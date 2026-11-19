// Compressed / edited copies not opened yet: each copy the compress queue
// saves (server/compressQueue.ts) is added, by its path inside the shared
// folder, and its card shows the "Compressed!" / "Edited!" badges until it's
// opened in the viewer (POST ROUTE_COMPRESS_SEEN). Saved in
// COMPRESSED_NEW_FILE, so every device sees the same. Moving or renaming the
// copy keeps it; trashing drops it (see handlers/files.ts).
//
// What was done to each (edited, compressed) is kept with it, and whether it
// replaced its original or was saved beside it as a copy: a file that
// replaced its original has the original's name, so its name can't tell.
// Older saves have paths only (or no `replaced`): the client tells those from
// their names.
//
// Kept on globalThis: Vite reloads server files after an edit
// (server/vitePlugin.ts), but a compress job already running keeps calling
// the version of this file it started with. With a list per version, that
// job's copy was marked in an old list (the gallery, using the new one, didn't
// know it), and any save from an old list wrote back copies already opened
// in the new one, so their badges came back. One list for every version.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { COMPRESSED_NEW_FILE } from './consts/server.ts'

/**
 * What was done to a new copy, and (`replaced`) whether it took its
 * original's place (the original went to the trash) instead of being saved
 * beside it; null: not known (saved before this was kept). `replaced` is
 * missing on ones saved before it was kept
 */
export type NewKind = { edited: boolean; compressed: boolean; replaced?: boolean } | null

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
        map.set(
          item.path,
          isKind(item)
            ? {
                edited: item.edited,
                compressed: item.compressed,
                // older saves don't have it: the client tells from the name
                ...(typeof item.replaced === 'boolean' ? { replaced: item.replaced } : {}),
              }
            : null,
        )
      }
    }
  } catch {
    // no file yet (or unreadable): none
  }
  return map
}

interface NewStore {
  /** The copies not opened yet, and what was done to each */
  unseen: Map<string, NewKind>
  /** Saves run one after another, so a quick second change can't be overwritten by the first */
  saving: Promise<void>
}

const KEY = Symbol.for('med.compressedNew')
const store = globalThis as typeof globalThis & { [KEY]?: NewStore }
/** Read from the file once per process; every later version of this file uses the same */
const shared: NewStore = (store[KEY] ??= { unseen: load(), saving: Promise.resolve() })
const unseen = shared.unseen

function save(): Promise<void> {
  const list = [...unseen]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, kind]) => (kind ? { path: rel, ...kind } : rel))
  shared.saving = shared.saving
    .catch(() => {})
    .then(async () => {
      // write a temp file, then rename: a crash mid-write can't leave half a file
      await mkdir(path.dirname(COMPRESSED_NEW_FILE), { recursive: true })
      const tmp = `${COMPRESSED_NEW_FILE}.tmp`
      await writeFile(tmp, JSON.stringify(list, null, 2) + '\n')
      await rename(tmp, COMPRESSED_NEW_FILE)
    })
  return shared.saving
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
