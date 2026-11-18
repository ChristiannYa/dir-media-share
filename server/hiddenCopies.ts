// Copies that exist on disk but aren't to be shown yet: the edited copy of an
// "edit + compress" job (server/compressQueue.ts) is a step towards the
// compressed one, which replaces it. Until then the listing leaves it out, so
// the gallery only gets the finished file. By path inside the shared folder,
// as the listing shows it.
//
// In memory only: the queue puts its copies back after a restart (it saves
// their paths). Kept on globalThis: Vite reloads server files after an edit
// (server/vitePlugin.ts), and the list must survive that.

const KEY = Symbol.for('med.hiddenCopies')
const store = globalThis as typeof globalThis & { [KEY]?: Set<string> }
const hidden = (store[KEY] ??= new Set<string>())

/** Keeps `rel` out of the listings */
export function hideCopy(rel: string) {
  hidden.add(rel)
}

/** Lets `rel` show again (it's gone, or it's the result after all) */
export function unhideCopy(rel: string | null) {
  if (rel) hidden.delete(rel)
}

export function isHiddenCopy(rel: string): boolean {
  return hidden.has(rel)
}
