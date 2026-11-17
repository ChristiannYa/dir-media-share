// Cropping a photo in the browser (the edit dialog). The copy keeps the
// format (JPEG / PNG / WebP; Safari writes PNG when asked for WebP) and is
// named "<name>_edited.<ext>". Rotation from the camera is applied to the
// pixels; other metadata (camera, GPS, date taken) isn't kept.

import { EDITED_SUFFIX } from '@/constants'

/** Fractions (0–1) of the picture as shown */
export interface CropBox {
  x: number
  y: number
  w: number
  h: number
}

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}
const EXT_OF: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** "beach.png" → "beach_edited.png" */
export function editedName(name: string, ext: string): string {
  const dot = name.lastIndexOf('.')
  let base = dot > 0 ? name.slice(0, dot) : name
  const tail = `${EDITED_SUFFIX}.${ext}`
  // names are at most 255 bytes: leave room for the suffix and a " (2)"
  const encoder = new TextEncoder()
  const room = 255 - encoder.encode(tail).length - 8
  while (encoder.encode(base).length > room) base = base.slice(0, -1)
  return `${base}${tail}`
}

/** Crops the photo at `url` (named `name`) and returns the copy, ready to upload */
export async function cropImage(
  url: string,
  name: string,
  crop: CropBox,
  signal: AbortSignal,
): Promise<File> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Loading the photo failed (${res.status})`)
  // applies the EXIF rotation, as the <img> in the dialog shows it
  const bitmap = await createImageBitmap(await res.blob()).catch((): never => {
    throw new Error('The browser could not read this photo')
  })
  const canvas = document.createElement('canvas')
  try {
    const sx = Math.round(crop.x * bitmap.width)
    const sy = Math.round(crop.y * bitmap.height)
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(crop.w * bitmap.width)))
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(crop.h * bitmap.height)))
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser could not draw the picture')
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)

    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const type = TYPES[ext] ?? 'image/png'
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('The browser could not encode the picture'))),
        type,
        0.95,
      ),
    )
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    // keep "jpeg" vs "jpg" as it was, unless the browser wrote another format
    const outExt = blob.type === type ? ext : (EXT_OF[blob.type] ?? 'png')
    return new File([blob], editedName(name, outExt), { type: blob.type })
  } finally {
    bitmap.close()
    // frees the pixels right away instead of waiting for garbage collection
    canvas.width = 0
    canvas.height = 0
  }
}
