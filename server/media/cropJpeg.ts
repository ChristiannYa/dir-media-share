// Cropping a JPEG without re-compressing it: jpegtran (libjpeg-turbo) cuts
// the compressed blocks out as they are, so the copy has exactly the
// original's pixels, and keeps its metadata (color profile, EXIF, the
// camera's rotation).
//
// One catch of a lossless crop: its top-left corner can only start on the
// JPEG's block grid (every 8 or 16 px), so jpegtran moves it up / left to the
// nearest block edge: the copy can keep up to 15 px more on those sides.
//
// 1. jpegtran writes into a hidden file next to the photo
// 2. It's saved next to the original as "<name>_edited.<ext>". The original
//    is never touched.

import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { EDITED_SUFFIX } from '../consts/edit.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { claimName } from '../names.ts'
import { relativePath } from '../paths.ts'
import { run } from '../run.ts'
import { EditError, type EditResult } from './edit.ts'

/** The crop, in fractions (0–1) of the photo as it's shown (the camera's rotation applied) */
export interface CropBox {
  x: number
  y: number
  w: number
  h: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function isJpegName(name: string): boolean {
  return /\.jpe?g$/i.test(name)
}

/** "beach.jpg" → "beach_edited.jpg" */
function editedName(file: string): string {
  const ext = path.extname(file)
  let base = path.basename(file, ext)
  const tail = `${EDITED_SUFFIX}${ext}`
  // names are at most 255 bytes; leave room for the suffix and a " (2)"
  const room = 255 - Buffer.byteLength(tail) - 8
  while (Buffer.byteLength(base) > room) base = base.slice(0, -1)
  return `${base}${tail}`
}

interface JpegLayout {
  /** Size as stored, before the camera's rotation */
  width: number
  height: number
  /** EXIF orientation, 1–8 (1: as stored) */
  orientation: number
}

/** The EXIF orientation in an APP1 segment's TIFF data at `tiff`; 1 if none */
function exifOrientation(buf: Buffer, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1
  const order = buf.toString('latin1', tiff, tiff + 2)
  if (order !== 'II' && order !== 'MM') return 1
  const le = order === 'II'
  const u16 = (at: number) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at))
  const u32 = (at: number) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) break
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

/** Reads the stored size and EXIF orientation from the JPEG's headers */
function jpegLayout(buf: Buffer): JpegLayout | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let orientation = 1
  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]!
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    const length = buf.readUInt16BE(i + 2)
    const data = i + 4
    const end = Math.min(i + 2 + length, buf.length)
    // APP1 "Exif\0\0": the rotation
    if (marker === 0xe1 && buf.toString('latin1', data, data + 6) === 'Exif\0\0') {
      orientation = exifOrientation(buf, data + 6, end)
    }
    // SOF0–SOF15 (not DHT C4, JPG C8, DAC CC): the size
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (data + 5 > buf.length) return null
      return {
        height: buf.readUInt16BE(data + 1),
        width: buf.readUInt16BE(data + 3),
        orientation,
      }
    }
    if (marker === 0xda) return null // the picture data began with no size
    i += 2 + length
  }
  return null
}

/**
 * The crop as shown → the same crop of the picture as stored. The copy keeps
 * the EXIF orientation, so it's shown turned the same way as the original
 */
function storedBox({ x, y, w, h }: CropBox, orientation: number): CropBox {
  switch (orientation) {
    case 2: // mirrored left–right
      return { x: 1 - x - w, y, w, h }
    case 3: // turned 180°
      return { x: 1 - x - w, y: 1 - y - h, w, h }
    case 4: // mirrored top–bottom
      return { x, y: 1 - y - h, w, h }
    case 5: // mirrored along the top-left–bottom-right diagonal
      return { x: y, y: x, w: h, h: w }
    case 6: // shown turned 90° clockwise
      return { x: y, y: 1 - x - w, w: h, h: w }
    case 7: // mirrored along the other diagonal
      return { x: 1 - y - h, y: 1 - x - w, w: h, h: w }
    case 8: // shown turned 90° counterclockwise
      return { x: 1 - y - h, y: x, w: h, h: w }
    default:
      return { x, y, w, h }
  }
}

/**
 * Saves a losslessly cropped copy of the JPEG `file` (a real path inside the
 * shared folder) next to it. Aborting `signal` stops it; no copy is kept.
 */
export async function cropJpeg(
  file: string,
  crop: CropBox,
  signal: AbortSignal,
): Promise<EditResult> {
  const layout = jpegLayout(await readFile(file))
  if (!layout) throw new EditError("The photo couldn't be read")

  const fx = clamp(crop.x, 0, 1)
  const fy = clamp(crop.y, 0, 1)
  const shown = { x: fx, y: fy, w: clamp(crop.w, 0, 1 - fx), h: clamp(crop.h, 0, 1 - fy) }
  if (shown.x < 0.001 && shown.y < 0.001 && shown.w > 0.999 && shown.h > 0.999) {
    throw new EditError('Nothing was changed')
  }

  const box = storedBox(shown, layout.orientation)
  const x = clamp(Math.round(box.x * layout.width), 0, layout.width - 1)
  const y = clamp(Math.round(box.y * layout.height), 0, layout.height - 1)
  const w = clamp(Math.round(box.w * layout.width), 1, layout.width - x)
  const h = clamp(Math.round(box.h * layout.height), 1, layout.height - y)

  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${randomUUID()}.med-edit${UPLOAD_PART_SUFFIX}`)
  const args = ['-copy', 'all', '-crop', `${w}x${h}+${x}+${y}`, '-outfile', tmp, file]
  try {
    let result
    try {
      result = await run('jpegtran', args, signal)
    } catch (e) {
      if (signal.aborted) throw new EditError('Cancelled')
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EditError('jpegtran (libjpeg-turbo) is not installed on the server')
      }
      throw e
    }
    if (signal.aborted) throw new EditError('Cancelled')
    if (result.code !== 0) {
      console.error(`Cropping ${file} failed:\n${result.stderr.slice(-8000)}`)
      throw new EditError('jpegtran could not crop it (details in the server log)')
    }

    const saved = await claimName(tmp, dir, editedName(file))
    console.log(`Cropped ${file} → ${saved} (${w}×${h}+${x}+${y}, lossless)`)
    return { path: await relativePath(saved), name: path.basename(saved) }
  } finally {
    // already gone once it got its name
    await unlink(tmp).catch(() => {})
  }
}
