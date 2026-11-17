import {
  COMPRESSIBLE_EXTENSIONS,
  COMPRESSIBLE_IMAGE_EXTENSIONS,
  EDITABLE_IMAGE_EXTENSIONS,
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

/** Images and videos get thumbnails, the rainbow border and the loading indicator */
export function isMediaEntry(entry: Entry): boolean {
  return entry.kind === 'image' || entry.kind === 'video'
}
