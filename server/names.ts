// Giving a finished file its name in a folder without overwriting another
// (uploads and compressed copies).

import { link, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { exists } from './cache.ts'

/** "clip.mp4", then "clip (2).mp4", "clip (3).mp4"… */
function numberedName(name: string, n: number): string {
  if (n === 1) return name
  const ext = path.extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}

/**
 * Gives the finished `part` file its real name in `dir`, never overwriting an
 * existing file: a hard link fails if the name is taken, so two files of the
 * same name can't race. A taken name gets " (2)", " (3)"… Returns the final path.
 *
 * `hold` is for a file that must not show in the listings from the moment it
 * exists (the edited copy of an edit + compress job, server/hiddenCopies.ts):
 * it's told (name, true) just before a name nobody has is linked, so the file
 * is never seen, and (name, false) if that name didn't work out after all. On
 * success the name stays held: whoever asked lets it go. Names that are taken
 * are never held, so an existing file never drops out of a listing.
 */
export async function claimName(
  part: string,
  dir: string,
  name: string,
  hold?: (name: string, held: boolean) => void,
): Promise<string> {
  for (let n = 1; n <= 9999; n++) {
    const taken = numberedName(name, n)
    const target = path.join(dir, taken)
    if (hold) {
      if (await exists(target)) continue
      hold(taken, true)
    }
    try {
      await link(part, target)
      await unlink(part)
      return target
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        hold?.(taken, false)
        continue
      }
      // drives without hard links (FAT, some network shares): check, then rename
      if (await exists(target)) {
        hold?.(taken, false)
        continue
      }
      try {
        await rename(part, target)
      } catch (renameError) {
        hold?.(taken, false)
        throw renameError
      }
      return target
    }
  }
  throw new Error(`No free name for ${name}`)
}
