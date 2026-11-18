// Cropping PNGs and WebPs on the server (JPEGs: ./cropJpeg.ts), so the edit
// dialog's photo crops wait in the compress queue like everything else:
// - PNG: ffmpeg crops it into a PNG again: lossless, every pixel as it was
// - WebP: cwebp's own crop. A lossless WebP stays lossless (the exact pixels);
//   a lossy one is encoded again at EDIT_WEBP_QUALITY, high enough not to see.
//   EXIF and the color profile are kept. Animated WebPs can't be cropped
//
// One catch: a PNG / WebP turned by an EXIF rotation tag (rare, unlike
// JPEGs) is cropped as stored, not as shown.
//
// As with the other edits: written to a hidden file next to the photo, then
// saved as "<name>_edited.<ext>". The original is never touched.

import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { EDIT_WEBP_QUALITY } from '../consts/edit.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { tool } from './compressImage.ts'
import type { CropBox } from './cropJpeg.ts'
import { EditError, editedName, saveEdited, type EditResult, type HoldCopy } from './edit.ts'

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function isCroppableImageName(name: string): boolean {
  return /\.(png|webp)$/i.test(name)
}

interface WebpLayout {
  width: number
  height: number
  lossless: boolean
  animated: boolean
}

/** Reads a WebP's size and kind from its RIFF chunks; null if it isn't one */
function webpLayout(buf: Buffer): WebpLayout | null {
  if (buf.length < 30) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const layout: WebpLayout = { width: 0, height: 0, lossless: false, animated: false }
  let i = 12
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4)
    const size = buf.readUInt32LE(i + 4)
    const data = i + 8
    if (type === 'VP8X' && data + 10 <= buf.length) {
      // the extended header: flags, then the canvas size (24 bits each, minus one)
      layout.animated = (buf[data]! & 0x02) !== 0
      layout.width = buf.readUIntLE(data + 4, 3) + 1
      layout.height = buf.readUIntLE(data + 7, 3) + 1
    } else if (type === 'VP8 ' && data + 10 <= buf.length) {
      // lossy: the key frame's header holds the size (14 bits each)
      if (!layout.width) {
        layout.width = buf.readUInt16LE(data + 6) & 0x3fff
        layout.height = buf.readUInt16LE(data + 8) & 0x3fff
      }
      return layout
    } else if (type === 'VP8L' && data + 5 <= buf.length) {
      // lossless: after the signature byte, 14 bits each of the size minus one
      layout.lossless = true
      if (!layout.width) {
        const bits = buf.readUInt32LE(data + 1)
        layout.width = (bits & 0x3fff) + 1
        layout.height = ((bits >>> 14) & 0x3fff) + 1
      }
      return layout
    } else if (type === 'ANMF') {
      layout.animated = true
      return layout
    }
    i = data + size + (size & 1)
  }
  return null
}

/** The crop in whole pixels of a `width` × `height` picture */
function pixels(crop: CropBox, width: number, height: number) {
  const x = clamp(Math.round(crop.x * width), 0, width - 1)
  const y = clamp(Math.round(crop.y * height), 0, height - 1)
  const w = clamp(Math.round(crop.w * width), 1, width - x)
  const h = clamp(Math.round(crop.h * height), 1, height - y)
  return { x, y, w, h }
}

/**
 * Saves a cropped copy of the PNG / WebP `file` (a real path inside the
 * shared folder) next to it. Aborting `signal` stops it; no copy is kept.
 */
export async function cropImage(
  file: string,
  crop: CropBox,
  signal: AbortSignal,
  hold?: HoldCopy,
): Promise<EditResult> {
  const fx = clamp(crop.x, 0, 1)
  const fy = clamp(crop.y, 0, 1)
  const shown = { x: fx, y: fy, w: clamp(crop.w, 0, 1 - fx), h: clamp(crop.h, 0, 1 - fy) }
  if (shown.x < 0.001 && shown.y < 0.001 && shown.w > 0.999 && shown.h > 0.999) {
    throw new EditError('Nothing was changed')
  }
  const isWebp = /\.webp$/i.test(file)

  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${randomUUID()}.med-edit${UPLOAD_PART_SUFFIX}`)
  try {
    let program: string
    if (isWebp) {
      const layout = webpLayout(await readFile(file))
      if (!layout?.width || !layout.height) throw new EditError("The photo couldn't be read")
      if (layout.animated) throw new EditError("Animated WebPs can't be cropped")
      const box = pixels(shown, layout.width, layout.height)
      program = 'cwebp'
      const quality = layout.lossless
        ? // lossless, keeping the pixels under transparent areas too; 6 is the
          // usual balance of size and time
          ['-z', '6', '-exact']
        : ['-q', String(EDIT_WEBP_QUALITY), '-m', '6', '-sharp_yuv']
      const result = await tool(
        'cwebp',
        'libwebp-utils',
        [
          '-quiet',
          '-crop',
          String(box.x),
          String(box.y),
          String(box.w),
          String(box.h),
          ...quality,
          '-metadata',
          'exif,icc',
          file,
          '-o',
          tmp,
        ],
        signal,
      )
      if (signal.aborted) throw new EditError('Cancelled')
      if (result.code !== 0) {
        console.error(`Cropping ${file} failed:\n${result.stderr.slice(-8000)}`)
        throw new EditError('cwebp could not crop it (details in the server log)')
      }
    } else {
      // ffmpeg works the pixels out itself (iw / ih: the PNG's size)
      const f = (n: number) => n.toFixed(6)
      program = 'ffmpeg'
      const result = await tool(
        'ffmpeg',
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-i',
          file,
          '-vf',
          // at least a pixel each way; x / y are kept inside the picture by the filter
          `crop=w=max(1\\,round(iw*${f(shown.w)})):h=max(1\\,round(ih*${f(shown.h)})):x=round(iw*${f(shown.x)}):y=round(ih*${f(shown.y)})`,
          '-frames:v',
          '1',
          '-c:v',
          'png',
          // one picture to a plain name (not a numbered sequence)
          '-f',
          'image2',
          '-update',
          '1',
          tmp,
        ],
        signal,
      )
      if (signal.aborted) throw new EditError('Cancelled')
      if (result.code !== 0) {
        console.error(`Cropping ${file} failed:\n${result.stderr.slice(-8000)}`)
        throw new EditError('ffmpeg could not crop it (details in the server log)')
      }
    }

    const { saved, result: made } = await saveEdited(tmp, file, editedName(file), signal, hold)
    console.log(`Cropped ${file} → ${saved} with ${program}`)
    return made
  } finally {
    // already gone once it got its name
    await unlink(tmp).catch(() => {})
  }
}
