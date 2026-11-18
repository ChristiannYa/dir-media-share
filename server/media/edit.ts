// Saving an edited copy of a video: its start and/or end cut off, its edges
// cropped. Re-encoded (AAC audio in MP4), so cuts land on the exact frame:
// - 8-bit SDR videos: H.264, 8-bit
// - 10-bit or HDR videos (iPhones record 10-bit HLG): HEVC, 10-bit, so the
//   colors aren't squashed into 8-bit SDR (washed out, banding)
// Either way the original's color tags are written on the copy. The quality
// is fixed (server/consts/edit.ts), and ffmpeg runs like the compressions'
// (./compress.ts runFfmpeg): lowest CPU priority, a share of the threads.
//
// 1. ffmpeg writes into a hidden file next to the video
// 2. It's saved next to the original as "clip_edited.mp4". The original is
//    never touched.
//
// Run by the compress queue in the background (./editMedia.ts); its Discard
// can delete the copy again for a while, like a compressed one's.

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  EDIT_AUDIO_BITRATE,
  EDIT_CRF,
  EDIT_HEVC_CRF,
  EDIT_HEVC_PRESET,
  EDIT_PRESET,
  EDITED_SUFFIX,
} from '../consts/edit.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { claimName } from '../names.ts'
import { relativePath } from '../paths.ts'
import {
  CompressError,
  encodeThreads,
  rememberCopy,
  runFfmpeg,
  type CompressProgress,
} from './compress.ts'
import { PROGRESS_ARGS } from './ffmpeg.ts'
import { videoInfo, type VideoInfo } from './probe.ts'

/** A problem to show the user as is (a CompressError, so the queue shows it like one) */
export class EditError extends CompressError {}

/**
 * What the edit dialog asks for: the part to keep (seconds) and the crop, in
 * fractions (0–1) of the picture as it's shown (rotation applied). Photos
 * have nothing to trim: their start and end are unused
 */
export interface VideoEdit {
  start: number
  end: number
  x: number
  y: number
  w: number
  h: number
}

export interface EditResult {
  /** The edited copy's path inside the shared folder */
  path: string
  /** Its file name */
  name: string
}

/** Shortest part that can be kept, in seconds */
export const MIN_LENGTH = 0.1

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
/** 4:2:0 video needs even sizes */
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

/** Transfers of HDR video: PQ (HDR10, Dolby Vision's base) and HLG (iPhones) */
const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67']

/** More than 8 bits per sample: "yuv420p10le", "p010le", "yuv422p12le"… */
const isHighBitDepth = (pixFmt: string | null) => /1[0-6](le|be)$/.test(pixFmt ?? '')

/**
 * How the picture is encoded. 10-bit or HDR sources keep 10 bits and their
 * HDR transfer in HEVC ("hvc1": the tag Safari / iOS need to play it; recent
 * Chrome and Edge play it too with hardware decoding). The rest stays H.264,
 * which plays everywhere
 */
function videoCodecArgs(info: VideoInfo, threads: string): string[] {
  const keepTenBit =
    isHighBitDepth(info.pixFmt) || HDR_TRANSFERS.includes(info.colorTransfer ?? '')
  const codec = keepTenBit
    ? [
        '-c:v',
        'libx265',
        '-preset',
        EDIT_HEVC_PRESET,
        '-crf',
        String(EDIT_HEVC_CRF),
        '-pix_fmt',
        'yuv420p10le',
        '-tag:v',
        'hvc1',
        // x265 has its own thread pool, which ffmpeg's -threads doesn't size
        '-x265-params',
        `log-level=error:pools=${threads}`,
      ]
    : [
        '-c:v',
        'libx264',
        '-preset',
        EDIT_PRESET,
        '-crf',
        String(EDIT_CRF),
        '-pix_fmt',
        'yuv420p',
      ]
  // the original's color tags, so players show the same colors (an untagged
  // HDR copy would be read as SDR)
  const tags: Array<[string, string | null]> = [
    ['-color_primaries', info.colorPrimaries],
    ['-color_trc', info.colorTransfer],
    ['-colorspace', info.colorSpace],
    ['-color_range', info.colorRange],
  ]
  for (const [flag, value] of tags) if (value) codec.push(flag, value)
  return codec
}

/**
 * "clip.mov" → "clip_edited.mov" (`ext`, with its dot: the original's unless
 * given; videos are always ".mp4", that's what they now are)
 */
export function editedName(file: string, ext = path.extname(file)): string {
  let base = path.basename(file, path.extname(file))
  const tail = `${EDITED_SUFFIX}${ext}`
  // names are at most 255 bytes; leave room for the suffix and a " (2)"
  const room = 255 - Buffer.byteLength(tail) - 8
  while (Buffer.byteLength(base) > room) base = base.slice(0, -1)
  return `${base}${tail}`
}

/**
 * Tells the listings to keep a name out (true) or lets it show (false): for a
 * copy that is only a step towards another (see `claimName`'s `hold`)
 */
export type HoldCopy = (name: string, held: boolean) => void

/**
 * Gives the finished hidden file `tmp` its name next to `file`, lets the
 * queue's Discard delete it for a while, and answers where it went. Stopped
 * while it was being named: it's removed again. With `hold`, the name is kept
 * out of the listings from before the file exists, and stays held (the caller
 * lets it go) unless this fails
 */
export async function saveEdited(
  tmp: string,
  file: string,
  name: string,
  signal: AbortSignal,
  hold?: HoldCopy,
): Promise<{ saved: string; result: EditResult }> {
  const saved = await claimName(tmp, path.dirname(file), name, hold)
  try {
    if (signal.aborted) throw new EditError('Cancelled')
    rememberCopy(saved)
    return { saved, result: { path: await relativePath(saved), name: path.basename(saved) } }
  } catch (e) {
    // nobody gets this copy: gone, and its name no longer held
    await unlink(saved).catch(() => {})
    hold?.(path.basename(saved), false)
    throw e
  }
}

/**
 * Saves an edited copy of `file` (a real path inside the shared folder) next
 * to it. `onProgress` hears how far it got and how fast. Aborting `signal`
 * stops it; no copy is kept.
 */
export async function editVideo(
  file: string,
  edit: VideoEdit,
  signal: AbortSignal,
  onProgress: (p: CompressProgress) => void,
  hold?: HoldCopy,
): Promise<EditResult> {
  const info = await videoInfo(file)
  if (!info?.width || !info.height) throw new EditError("The video couldn't be read")

  const start = clamp(edit.start, 0, info.duration)
  const end = clamp(edit.end, 0, info.duration)
  if (end - start < MIN_LENGTH) throw new EditError('The part to keep is too short')

  // fractions → pixels of the picture as shown (videoInfo swaps the sides of
  // videos recorded sideways, and ffmpeg rotates them before the crop filter)
  const fx = clamp(edit.x, 0, 1)
  const fy = clamp(edit.y, 0, 1)
  const fw = clamp(edit.w, 0, 1 - fx)
  const fh = clamp(edit.h, 0, 1 - fy)
  const w = Math.min(even(fw * info.width), even(info.width))
  const h = Math.min(even(fh * info.height), even(info.height))
  const x = clamp(Math.round(fx * info.width), 0, info.width - w)
  const y = clamp(Math.round(fy * info.height), 0, info.height - h)

  const trimmed = start > 0.05 || end < info.duration - 0.05
  const cropped = fx > 0.001 || fy > 0.001 || fw < 0.999 || fh < 0.999
  if (!trimmed && !cropped) throw new EditError('Nothing was changed')

  const length = end - start
  const threads = String(encodeThreads())
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${randomUUID()}.med-edit${UPLOAD_PART_SUFFIX}`)
  const args = [
    ...PROGRESS_ARGS,
    '-v',
    'error',
    '-nostdin',
    '-y',
    // fewer threads for the decoder and the filters, as in a compression
    '-threads',
    threads,
    '-filter_threads',
    threads,
    // -ss before -i: fast seek, still frame-exact since it's re-encoded
    '-ss',
    start.toFixed(3),
    '-i',
    file,
    '-t',
    length.toFixed(3),
    // the video (not cover art) and every audio track
    '-map',
    '0:V:0',
    '-map',
    '0:a?',
    '-map_metadata',
    '0',
    '-vf',
    `crop=${w}:${h}:${x}:${y}`,
    // the encoder's own thread count (the one above is the decoder's)
    '-threads',
    threads,
    ...videoCodecArgs(info, threads),
    '-c:a',
    'aac',
    '-b:a',
    EDIT_AUDIO_BITRATE,
    // the index at the start, so browsers can play it before it's fully downloaded
    '-movflags',
    '+faststart',
    // given explicitly: the hidden output's name has no usable extension
    '-f',
    'mp4',
    tmp,
  ]
  try {
    let result: { code: number | null; stderr: string }
    try {
      result = await runFfmpeg(args, length, signal, onProgress)
    } catch (e) {
      if (signal.aborted) throw new EditError('Cancelled')
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EditError('nice is not installed on the server')
      }
      throw e
    }
    if (signal.aborted) throw new EditError('Cancelled')
    if (result.code !== 0) {
      // `nice` answers 127 when it can't find ffmpeg
      if (result.code === 127) throw new EditError('ffmpeg is not installed on the server')
      console.error(`Editing ${file} failed:\n${result.stderr}`)
      if (/Unknown encoder 'libx265'/.test(result.stderr)) {
        throw new EditError("This server's ffmpeg has no HEVC encoder (libx265) for 10-bit / HDR videos")
      }
      throw new EditError('ffmpeg could not edit it (details in the server log)')
    }

    const { saved, result: made } = await saveEdited(
      tmp,
      file,
      editedName(file, '.mp4'),
      signal,
      hold,
    )
    console.log(
      `Edited ${file} → ${saved} (${start.toFixed(2)}–${end.toFixed(2)} s, crop ${w}×${h}+${x}+${y})`,
    )
    return made
  } finally {
    // already gone once it got its name
    await unlink(tmp).catch(() => {})
  }
}
