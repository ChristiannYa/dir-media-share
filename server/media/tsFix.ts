// Fixing MPEG-TS videos saved as .mp4 (the red "TS" badge), which browsers
// can't play: the streams are copied as they are into a real MP4 container
// (a remux, no re-encoding, so it's fast and loses nothing).
//
// 1. ffmpeg writes into a hidden file next to the video
// 2. It's saved next to the original as "clip_ts_fix.mp4". The original is
//    never touched.

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { TS_FIX_SUFFIX } from '../consts/tsFix.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { claimName } from '../names.ts'
import { relativePath } from '../paths.ts'
import { run, type RunResult } from '../run.ts'
import { PROGRESS_ARGS, progressReader } from './ffmpeg.ts'
import { isMpegts, videoInfo } from './probe.ts'

/** A problem to show the user as is */
export class TsFixError extends Error {}

export interface TsFixResult {
  /** The fixed copy's path inside the shared folder */
  path: string
  /** Its file name */
  name: string
}

function remuxArgs(input: string, out: string, audio: 'copy' | 'encode'): string[] {
  return [
    '-v',
    'error',
    '-nostdin',
    '-y',
    '-i',
    input,
    // video and every audio track; TS data streams (ID3, SCTE-35…) can't go into MP4
    '-map',
    '0:v',
    '-map',
    '0:a?',
    '-map_metadata',
    '0',
    '-c:v',
    'copy',
    ...(audio === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']),
    // the index at the start, so browsers can play it before it's fully downloaded
    '-movflags',
    '+faststart',
    // given explicitly: the hidden output's name has no usable extension
    '-f',
    'mp4',
    out,
  ]
}

/** "clip.mp4" → "clip_ts_fix.mp4" (always .mp4: that's what it now is) */
function fixedName(file: string): string {
  let base = path.basename(file, path.extname(file))
  const tail = `${TS_FIX_SUFFIX}.mp4`
  // names are at most 255 bytes; leave room for the suffix and a " (2)"
  const room = 255 - Buffer.byteLength(tail) - 8
  while (Buffer.byteLength(base) > room) base = base.slice(0, -1)
  return `${base}${tail}`
}

/**
 * Saves a playable MP4 copy of an MPEG-TS video (`file`: a real path inside
 * the shared folder) next to it. `onProgress` hears 0–1 of it written.
 * Aborting `signal` stops it; no copy is kept.
 */
export async function fixTs(
  file: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<TsFixResult> {
  const info = await videoInfo(file)
  if (!info) throw new TsFixError("The video couldn't be read")
  if (!isMpegts(info)) throw new TsFixError('This video is not MPEG-TS, it needs no fixing')

  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${randomUUID()}.med-tsfix${UPLOAD_PART_SUFFIX}`)
  const remux = (audio: 'copy' | 'encode') =>
    run(
      'ffmpeg',
      [...PROGRESS_ARGS, ...remuxArgs(file, tmp, audio)],
      signal,
      progressReader(info.duration, onProgress),
    )
  try {
    let result: RunResult
    try {
      result = await remux('copy')
      if (result.code !== 0 && !signal.aborted) {
        // most likely the audio's codec can't go into MP4 as is: encode just the audio
        console.warn(`Remuxing ${file} with the audio copied failed, encoding the audio too`)
        onProgress(0)
        result = await remux('encode')
      }
    } catch (e) {
      if (signal.aborted) throw new TsFixError('Cancelled')
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TsFixError('ffmpeg is not installed on the server')
      }
      throw e
    }
    if (signal.aborted) throw new TsFixError('Cancelled')
    if (result.code !== 0) {
      console.error(`Fixing ${file} failed:\n${result.stderr.slice(-8000)}`)
      throw new TsFixError('ffmpeg could not fix it (details in the server log)')
    }

    const saved = await claimName(tmp, dir, fixedName(file))
    console.log(`Fixed MPEG-TS ${file} → ${saved}`)
    return { path: await relativePath(saved), name: path.basename(saved) }
  } finally {
    // already gone once it got its name
    await unlink(tmp).catch(() => {})
  }
}
