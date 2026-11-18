// Compressing a video into a new, smaller copy: same resolution, frame timing
// and audio (screen recordings are saved at a very high bitrate).
//
// 1. ffmpeg encodes into a hidden file next to the video
// 2. If that isn't at least COMPRESS_MIN_SAVING % smaller, it's thrown away
// 3. Otherwise it's saved next to the original, named after the settings
//    used: "clip.mp4" → "clip [x264 crf20 slow].mp4". The original is never
//    touched.
//
// For a while afterwards, `discardCompressed` can delete such a copy again
// (the compress dialog's Cancel); it refuses any other file. Photos are
// compressed by ./compressImage.ts, whose copies it can delete too.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  COMPRESS_CRF,
  COMPRESS_DISCARD_WINDOW_MS,
  COMPRESS_MAX_JOBS,
  COMPRESS_CPU_SHARE,
  COMPRESS_MIN_SAVING,
  COMPRESS_NICE,
  COMPRESS_PRESET,
  COMPRESS_VP9_CRF,
} from '../consts/compress.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { isVideoName } from '../listing.ts'
import { claimName } from '../names.ts'
import { relativePath } from '../paths.ts'
import { run } from '../run.ts'
import { Semaphore } from '../semaphore.ts'
import { purgeVideo } from './purge.ts'

/** A problem to show the user as is */
export class CompressError extends Error {}

export interface CompressProgress {
  /** 0–1 of the video encoded */
  fraction: number
  /** Encoding speed in × real time (2 = a minute of video takes 30 s); null until known */
  speed: number | null
}

export interface CompressResult {
  /** Size of the original, in bytes */
  before: number
  /** Size of the copy (the same as before if none was saved) */
  after: number
  /** False if no copy was saved; `note` says why */
  compressed: boolean
  /** The copy's path inside the shared folder and its name (compressed only) */
  path?: string
  name?: string
  note?: string
}

/** How each kind of file is written: its own container, a codec it can hold */
interface Target {
  /** ffmpeg's muxer name (given explicitly: the hidden output's name has no usable extension) */
  format: string
  video: 'x264' | 'vp9'
}

const TARGETS: Record<string, Target> = {
  mp4: { format: 'mp4', video: 'x264' },
  m4v: { format: 'mp4', video: 'x264' },
  mov: { format: 'mov', video: 'x264' },
  mkv: { format: 'matroska', video: 'x264' },
  // WebM can only hold VP8/VP9/AV1; VP9 plays in every current browser
  webm: { format: 'webm', video: 'vp9' },
}

/** Compressions running at once: each already keeps every CPU core busy */
const JOBS = new Semaphore(COMPRESS_MAX_JOBS)

// ── Probing ──

interface ProbeStream {
  codec_type?: string
  pix_fmt?: string
  disposition?: { attached_pic?: number }
}

interface ProbeOutput {
  format?: { duration?: string }
  streams?: ProbeStream[]
}

async function probe(file: string): Promise<ProbeOutput | null> {
  try {
    const result = await run('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ])
    return JSON.parse(result.stdout) as ProbeOutput
  } catch {
    return null
  }
}

/**
 * 10-bit and up (HDR phone videos, mostly): the browser-playable H.264 / VP9
 * profiles are 8-bit, so re-encoding would lose it
 */
function isHighBitDepth(pixFmt: string | undefined): boolean {
  return !!pixFmt && (/(9|10|12|14|16)(le|be)$/.test(pixFmt) || pixFmt.startsWith('p01'))
}

// ── Encoding ──

interface EncodeOptions {
  crf: number
  preset: string
  vp9Crf: number
  /** Copy the audio as is, or encode it (when it can't go into the container as is) */
  audio: 'copy' | 'encode'
}

/** Threads an encode may use: COMPRESS_CPU_SHARE of the CPU's, at least one */
function encodeThreads(): number {
  return Math.max(1, Math.floor(os.availableParallelism() * COMPRESS_CPU_SHARE))
}

function encodeArgs(input: string, out: string, target: Target, o: EncodeOptions): string[] {
  const threads = String(encodeThreads())
  const args = [
    '-v',
    'error',
    '-nostdin',
    '-y',
    // fewer threads for the decoder, the filters and the encoder: slower, but
    // the laptop stays cool (ffmpeg uses every core otherwise)
    '-threads',
    threads,
    '-filter_threads',
    threads,
    '-i',
    input,
    // the video (not cover art) and every audio track, e.g. OBS's separate mic / desktop tracks
    '-map',
    '0:V:0',
    '-map',
    '0:a?',
    '-map_metadata',
    '0',
    // keep every frame's timestamp as it is: screen recordings are often
    // variable frame rate, and nothing may be dropped or duplicated
    '-fps_mode',
    'passthrough',
  ]
  // the encoder's own thread count (the one above is the decoder's)
  args.push('-threads', threads)
  if (target.video === 'x264') {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      o.preset,
      '-crf',
      String(o.crf),
      // 4:2:0 is what browsers play; it needs even sizes (window captures can be odd): pads 1px if so
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-pix_fmt',
      'yuv420p',
    )
  } else {
    args.push(
      '-c:v',
      'libvpx-vp9',
      '-crf',
      String(o.vp9Crf),
      '-b:v',
      '0',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-row-mt',
      '1',
      '-pix_fmt',
      'yuv420p',
    )
  }
  if (o.audio === 'copy') args.push('-c:a', 'copy')
  else if (target.video === 'vp9') args.push('-c:a', 'libopus', '-b:a', '192k')
  else args.push('-c:a', 'aac', '-b:a', '256k')
  // the index at the start, so browsers can play it before it's fully downloaded
  if (target.format === 'mp4' || target.format === 'mov') args.push('-movflags', '+faststart')
  args.push('-f', target.format, '-progress', 'pipe:1', '-nostats', out)
  return args
}

/** What the copy is called: the original's name with the settings used, e.g. "clip [x264 crf20 slow].mp4" */
function copyName(file: string, target: Target, o: EncodeOptions): string {
  const ext = path.extname(file)
  let base = path.basename(file, ext)
  const tag =
    target.video === 'x264' ? `[x264 crf${o.crf} ${o.preset}]` : `[vp9 crf${o.vp9Crf}]`
  // names are at most 255 bytes; leave room for the tag, the extension and a " (2)"
  const room = 255 - Buffer.byteLength(` ${tag}${ext}`) - 8
  while (Buffer.byteLength(base) > room) base = base.slice(0, -1)
  return `${base} ${tag}${ext}`
}

/**
 * Runs ffmpeg at the lowest CPU priority and on a share of the threads (so
 * the laptop stays cool and the gallery responsive), reporting its progress. Aborting `signal` kills it.
 */
function runFfmpeg(
  args: string[],
  duration: number,
  signal: AbortSignal,
  onProgress: (p: CompressProgress) => void,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('nice', ['-n', String(COMPRESS_NICE), 'ffmpeg', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    let time = 0
    let speed: number | null = null

    // -progress writes key=value lines, each block ending with progress=continue|end
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      let nl: number
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim()
        stdout = stdout.slice(nl + 1)
        const [key, value = ''] = line.split('=', 2)
        if (key === 'out_time_us') {
          const us = Number(value)
          if (Number.isFinite(us) && us > 0) time = us / 1_000_000
        } else if (key === 'speed') {
          const x = parseFloat(value)
          speed = Number.isFinite(x) && x > 0 ? x : null
        } else if (key === 'progress') {
          onProgress({ fraction: duration > 0 ? Math.min(1, time / duration) : 0, speed })
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000) // the end is what explains a failure
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

// ── Discarding ──

/** Copies saved by a compression (real path) → when, so Cancel can delete them; nothing else can be */
const copies = new Map<string, number>()

/** Lets Cancel delete `file` (a copy just saved by a compression, video or photo) */
export function rememberCopy(file: string) {
  const now = Date.now()
  for (const [f, at] of copies) if (now - at > COMPRESS_DISCARD_WINDOW_MS) copies.delete(f)
  copies.set(file, now)
}

/**
 * Deletes a copy saved by a compression in the last COMPRESS_DISCARD_WINDOW_MS,
 * for good, with its cached still / preview / storyboard. False for any other file.
 */
export async function discardCompressed(file: string): Promise<boolean> {
  const at = copies.get(file)
  if (at === undefined || Date.now() - at > COMPRESS_DISCARD_WINDOW_MS) return false
  // the cache names are worked out from the file, so do this while it's still there
  // (photos have no still, preview or storyboard)
  if (isVideoName(path.basename(file))) await purgeVideo(file).catch(() => 0)
  await unlink(file)
  copies.delete(file)
  console.log(`Discarded compressed copy ${file}`)
  return true
}

// ── Compressing ──

export interface CompressHooks {
  /** Aborting it stops the compression; no copy is kept */
  signal: AbortSignal
  /** Called once it's this video's turn and ffmpeg starts */
  onStart: () => void
  onProgress: (p: CompressProgress) => void
}

/** Saves a compressed copy of `file` (a real path inside the shared folder), waiting for its turn */
export function compressVideo(file: string, hooks: CompressHooks): Promise<CompressResult> {
  return JOBS.run(async () => {
    if (hooks.signal.aborted) throw new CompressError('Cancelled')
    hooks.onStart()
    return compressNow(file, hooks)
  })
}

async function compressNow(
  file: string,
  { signal, onProgress }: CompressHooks,
): Promise<CompressResult> {
  const original = await stat(file)
  const skip = (note: string): CompressResult => ({
    before: original.size,
    after: original.size,
    compressed: false,
    note,
  })

  const ext = path.extname(file).slice(1).toLowerCase()
  const target = TARGETS[ext]
  if (!target) return skip(`.${ext} files can't be compressed`)

  const info = await probe(file)
  if (!info) throw new CompressError("The video couldn't be read")
  const video = info.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video) return skip('There is no video in it to compress')
  if (isHighBitDepth(video.pix_fmt)) {
    return skip('10-bit / HDR video: compressing would lose that, so no copy was made')
  }
  const duration = Number(info.format?.duration) || 0
  const hasAudio = info.streams?.some((s) => s.codec_type === 'audio') ?? false

  // fixed values (server/consts/compress.ts), also used for the copy's name
  const options: EncodeOptions = {
    crf: COMPRESS_CRF,
    preset: COMPRESS_PRESET,
    vp9Crf: COMPRESS_VP9_CRF,
    audio: 'copy',
  }
  const minSaving = COMPRESS_MIN_SAVING

  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${randomUUID()}.med-compress${UPLOAD_PART_SUFFIX}`)
  try {
    let result = await runFfmpeg(encodeArgs(file, tmp, target, options), duration, signal, onProgress)
    if (result.code !== 0 && hasAudio && !signal.aborted) {
      // most likely the audio's codec can't go into this container as is: encode it too
      console.warn(`Compressing ${file} with the audio copied failed, encoding the audio too`)
      result = await runFfmpeg(
        encodeArgs(file, tmp, target, { ...options, audio: 'encode' }),
        duration,
        signal,
        onProgress,
      )
    }
    if (result.code !== 0) {
      // `nice` answers 127 when it can't find ffmpeg
      if (result.code === 127) throw new CompressError('ffmpeg is not installed on the server')
      console.error(`Compressing ${file} failed:\n${result.stderr}`)
      throw new CompressError('ffmpeg could not compress it (details in the server log)')
    }

    const after = (await stat(tmp)).size
    const saving = original.size > 0 ? (1 - after / original.size) * 100 : 0
    if (saving < minSaving) {
      return skip(
        saving <= 0
          ? `It would get ${Math.round(-saving)}% bigger, so no copy was made`
          : `Only ${Math.round(saving)}% smaller, so no copy was made`,
      )
    }
    // stopped while it was finishing: nobody wants the copy
    if (signal.aborted) throw new CompressError('Cancelled')

    const saved = await claimName(tmp, dir, copyName(file, target, options))
    // stopped while it was being named: remove it again
    if (signal.aborted) {
      await unlink(saved).catch(() => {})
      throw new CompressError('Cancelled')
    }
    rememberCopy(saved)
    console.log(`Compressed ${file} → ${saved}: ${original.size} → ${after} bytes`)
    return {
      before: original.size,
      after,
      compressed: true,
      path: await relativePath(saved),
      name: path.basename(saved),
    }
  } finally {
    // already gone once it got its name
    await unlink(tmp).catch(() => {})
  }
}
