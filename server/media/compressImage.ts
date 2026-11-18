// Compressing a photo into a new, smaller copy, like TinyPNG: the same format
// and size in pixels, each photo made as small as it can get without a
// visible change. The tool decides how far it can go for each photo:
//
// - JPEG: jpegoptim. Photos saved above COMPRESS_JPEG_QUALITY are re-encoded
//   at it; ones already at or below it are only optimized losslessly.
//   Comments, XMP and IPTC are dropped; EXIF (rotation, date) and the color
//   profile stay
// - PNG: pngquant reduces the colors to at most 256, picked for this image.
//   If it can't keep the quality within 20 of COMPRESS_PNG_QUALITY, the image
//   would visibly change, so no copy is made
// - WebP: re-encoded by cwebp at COMPRESS_WEBP_QUALITY
//
// As with videos (./compress.ts): written to a hidden file next to the photo,
// kept only if it's at least COMPRESS_MIN_SAVING % smaller, then named after
// the settings used ("photo.png" → "photo [pngquant q85].png"). The original
// is never touched, and the compress dialog's Cancel can delete the copy.

import { randomUUID } from 'node:crypto'
import { copyFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  COMPRESS_IMAGE_MAX_JOBS,
  COMPRESS_JPEG_QUALITY,
  COMPRESS_MIN_SAVING,
  COMPRESS_NICE,
  COMPRESS_PNG_QUALITY,
  COMPRESS_WEBP_QUALITY,
} from '../consts/compress.ts'
import { UPLOAD_PART_SUFFIX } from '../consts/uploads.ts'
import { claimName } from '../names.ts'
import { relativePath } from '../paths.ts'
import { run, type RunResult } from '../run.ts'
import { Semaphore } from '../semaphore.ts'
import { CompressError, rememberCopy, type CompressHooks, type CompressResult } from './compress.ts'

type Format = 'jpeg' | 'png' | 'webp'

const FORMATS: Record<string, Format> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' }

/** How far below COMPRESS_PNG_QUALITY pngquant may go before it gives up on a PNG */
const PNG_QUALITY_RANGE = 20

/**
 * Photos compressed at once; separate from the videos' line. Kept on
 * globalThis so a reload of this file keeps the same limiter (see ./compress.ts)
 */
const JOBS_KEY = Symbol.for('med.compressImageJobs')
const jobsStore = globalThis as typeof globalThis & { [JOBS_KEY]?: Semaphore }
const JOBS = (jobsStore[JOBS_KEY] ??= new Semaphore(COMPRESS_IMAGE_MAX_JOBS))

function formatOf(name: string): Format | undefined {
  const ext = path.extname(name).slice(1).toLowerCase()
  return Object.hasOwn(FORMATS, ext) ? FORMATS[ext] : undefined
}

/** True for photos this can compress (GIF would lose its animation; HEIC has no tool here) */
export function isCompressibleImageName(name: string): boolean {
  return formatOf(name) !== undefined
}

/**
 * Runs one of the tools. Throws a CompressError the user can read if it isn't
 * installed (naming the package to install), or "Cancelled" if aborted. The
 * photo edits run theirs with it too (./cropImage.ts)
 */
export async function tool(
  program: string,
  pkg: string,
  args: string[],
  signal: AbortSignal,
): Promise<RunResult> {
  try {
    // at the lowest CPU priority, like the video encodes; `nice` answers 127
    // when it can't find the program
    const result = await run('nice', ['-n', String(COMPRESS_NICE), program, ...args], signal)
    if (result.code === 127) {
      throw new CompressError(`${program} is not installed on the server (package "${pkg}")`)
    }
    return result
  } catch (e) {
    if (signal.aborted) throw new CompressError('Cancelled')
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CompressError(`${program} is not installed on the server (package "${pkg}")`)
    }
    throw e
  }
}

function failed(program: string, file: string, result: RunResult): never {
  console.error(`Compressing ${file} with ${program} failed (${result.code}):\n${result.stderr}`)
  throw new CompressError(`${program} could not compress it (details in the server log)`)
}

/** What the copy is called: the original's name with the settings used, e.g. "photo [jpeg q82].jpg" */
function copyName(file: string, tag: string): string {
  const ext = path.extname(file)
  let base = path.basename(file, ext)
  // names are at most 255 bytes; leave room for the tag, the extension and a " (2)"
  const room = 255 - Buffer.byteLength(` ${tag}${ext}`) - 8
  while (Buffer.byteLength(base) > room) base = base.slice(0, -1)
  return `${base} ${tag}${ext}`
}

/**
 * Runs `work` once it's its turn on the photos' line, which compressions and
 * photo edits (./editMedia.ts) share. `hooks.onStart` is called as it starts;
 * stopped while waiting, it never does
 */
export function onImageLine<T>(hooks: CompressHooks, work: () => Promise<T>): Promise<T> {
  return JOBS.run(async () => {
    if (hooks.signal.aborted) throw new CompressError('Cancelled')
    hooks.onStart()
    return work()
  })
}

/** Saves a compressed copy of the photo `file` (a real path inside the shared folder), waiting for its turn */
export function compressImage(file: string, hooks: CompressHooks): Promise<CompressResult> {
  return onImageLine(hooks, () => compressNow(file, hooks))
}

async function compressNow(file: string, { signal }: CompressHooks): Promise<CompressResult> {
  const original = await stat(file)
  const skip = (note: string): CompressResult => ({
    before: original.size,
    after: original.size,
    compressed: false,
    note,
  })
  const alreadySmall = "It's already about as small as it gets, so no copy was made"

  const format = formatOf(file)
  if (!format) return skip(`${path.extname(file) || 'These'} files can't be compressed`)

  const minSaving = COMPRESS_MIN_SAVING

  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${randomUUID()}.med-compress${UPLOAD_PART_SUFFIX}`)
  try {
    let tag: string
    if (format === 'jpeg') {
      const q = COMPRESS_JPEG_QUALITY
      tag = `[jpeg q${q}]`
      // jpegoptim works in place: on a copy, so the original is never touched
      await copyFile(file, tmp)
      const result = await tool(
        'jpegoptim',
        'jpegoptim',
        [
          '--quiet',
          `--max=${q}`,
          '--all-progressive',
          '--strip-com',
          '--strip-xmp',
          '--strip-iptc',
          tmp,
        ],
        signal,
      )
      if (result.code !== 0) failed('jpegoptim', file, result)
    } else if (format === 'png') {
      const q = COMPRESS_PNG_QUALITY
      tag = `[pngquant q${q}]`
      const result = await tool(
        'pngquant',
        'pngquant',
        [
          '--quality',
          `${Math.max(0, q - PNG_QUALITY_RANGE)}-${q}`,
          '--speed',
          '1',
          '--strip',
          '--skip-if-larger',
          '--force',
          '--output',
          tmp,
          '--',
          file,
        ],
        signal,
      )
      // pngquant's own answers: it couldn't keep the quality, or it'd get bigger
      if (result.code === 99) {
        return skip("It can't get smaller without visibly changing, so no copy was made")
      }
      if (result.code === 98) return skip(alreadySmall)
      if (result.code !== 0) failed('pngquant', file, result)
    } else {
      const q = COMPRESS_WEBP_QUALITY
      tag = `[webp q${q}]`
      const result = await tool(
        'cwebp',
        'libwebp-utils',
        ['-quiet', '-q', String(q), '-m', '6', '-metadata', 'exif,icc', file, '-o', tmp],
        signal,
      )
      if (result.code !== 0) failed('cwebp', file, result)
    }
    if (signal.aborted) throw new CompressError('Cancelled')

    const after = (await stat(tmp)).size
    const saving = original.size > 0 ? (1 - after / original.size) * 100 : 0
    if (saving < minSaving) {
      return skip(
        saving < 1 ? alreadySmall : `Only ${Math.round(saving)}% smaller, so no copy was made`,
      )
    }

    const saved = await claimName(tmp, dir, copyName(file, tag))
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
