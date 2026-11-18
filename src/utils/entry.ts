import {
  COMPRESSIBLE_EXTENSIONS,
  COMPRESSIBLE_IMAGE_EXTENSIONS,
  EDITABLE_IMAGE_EXTENSIONS,
  EDITED_SUFFIX,
} from '@/constants'
import type { Entry } from '@/types'

/** Videos (playable ones) and photos the edit dialog can trim / crop */
export function isEditable(entry: Entry): boolean {
  if (entry.kind === 'video') return !entry.needs_fix
  if (entry.kind === 'image') {
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
    return EDITABLE_IMAGE_EXTENSIONS.includes(ext)
  }
  return false
}

/** Videos and photos the server can save a compressed copy of */
export function isCompressible(entry: Entry): boolean {
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
  if (entry.kind === 'video') return COMPRESSIBLE_EXTENSIONS.includes(ext)
  if (entry.kind === 'image') return COMPRESSIBLE_IMAGE_EXTENSIONS.includes(ext)
  return false
}

/**
 * The path of the original a compressed copy was made from, worked out from
 * the copy's name: the server names it after the original with the settings
 * used ("clip.mp4" → "clip [x264 crf20 slow].mp4", maybe " (2)" after the tag
 * if that name was taken; server/media/compress.ts, compressImage.ts). Null if
 * the name isn't one of those (renamed since). The original may be gone
 * (moved, deleted): the caller finds out when it looks for it.
 */
export function compressedOriginalPath(entry: Entry): string | null {
  const original = entry.name.replace(
    / \[(?:x264|vp9|jpeg|pngquant|webp)[^\]]*\](?: \(\d+\))?(\.[^./]+)$/,
    '$1',
  )
  if (original === entry.name) return null
  const slash = entry.path.lastIndexOf('/')
  return slash < 0 ? original : `${entry.path.slice(0, slash + 1)}${original}`
}

/**
 * A copy a compression made, by the tag in its name ("clip [x264 crf20
 * slow].mp4"; server/media/compress.ts, compressImage.ts). An edited copy
 * compressed too has both: "clip_edited [x264 crf20 slow].mp4"
 */
export function isCompressedCopy(entry: Entry): boolean {
  return / \[(?:x264|vp9|jpeg|pngquant|webp)[^\]]*\](?: \(\d+\))?\.[^./]+$/.test(entry.name)
}

/**
 * A copy the edit dialog made, by its name: "clip_edited.mp4", maybe
 * "clip_edited (2).mp4" (server/media/edit.ts), or compressed too, "clip_edited
 * [x264 crf20 slow].mp4". Its new-copy banner says "Edited!" instead of
 * "Compressed!"
 */
export function isEditedCopy(entry: Entry): boolean {
  return new RegExp(`${EDITED_SUFFIX}(?: \\(\\d+\\))?(?: \\[[^\\]]*\\])?(?: \\(\\d+\\))?\\.[^./]+$`).test(
    entry.name,
  )
}

/**
 * What an edited copy was made from, by its name: the folder, the name
 * without extension ("clip_edited [x264 crf20 slow].mp4" → "clip") and the
 * extension the copy has. The original's own extension isn't in the name (a
 * video's copy is always .mp4), so it's looked for by name (findOriginal in
 * useGallery.ts). Null if it isn't an edited copy
 */
export function editedOriginalName(
  entry: Entry,
): { folder: string; base: string; ext: string } | null {
  const match = new RegExp(
    `^(.+)${EDITED_SUFFIX}(?: \\(\\d+\\))?(?: \\[[^\\]]*\\])?(?: \\(\\d+\\))?(\\.[^./]+)$`,
  ).exec(entry.name)
  if (!match) return null
  const slash = entry.path.lastIndexOf('/')
  return { folder: slash < 0 ? '' : entry.path.slice(0, slash), base: match[1]!, ext: match[2]! }
}

/** Images and videos get thumbnails, the rainbow border and the loading indicator */
export function isMediaEntry(entry: Entry): boolean {
  return entry.kind === 'image' || entry.kind === 'video'
}
