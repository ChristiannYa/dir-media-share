// Preview clip of a folder: slices of the videos directly inside it, or, if it
// has no videos, a slideshow of its images. Only folders that hold media
// themselves get one; a folder that only contains other folders has no preview.
//
// The videos / images are a random pick in a random order. The clip goes round
// the videos, one slice of each per round (v1, v2, v1, v2…), until each gave
// folderPreviewSlicesPerVideo slices or the clip has folderPreviewItems, so a
// folder with few videos still gets a full loop. A video's slices come from
// random moments of equal parts of it, in time order, so they never overlap. A folder has up to
// folderPreviewVariants such previews ("variants" 0, 1, 2…), each its own
// fixed pick and cache file; the card asks for one at random each time it
// appears, so the folder shows different previews while the cache stays at
// most that many files per folder.

import path from 'node:path'
import { cacheName, exists, mtimeSecs, once, tempFor } from '../cache.ts'
import { PREVIEW_FALLBACK_FPS } from '../consts/previews.ts'
import type { BuildHooks } from '../jobEvents.ts'
import { isSlideshowImageName, isVideoName } from '../listing.ts'
import { serverSettings as s } from '../settings.ts'
import { filesIn } from '../walk.ts'
import { MediaError } from './errors.ts'
import { ffmpegToFile } from './ffmpeg.ts'
import { cacheSettings, encodeArgs, JOBS } from './preview.ts'
import { videoInfo, type VideoInfo } from './probe.ts'

/** What a folder preview is made of */
export interface Source {
  kind: 'videos' | 'images'
  items: string[]
  /** Which of the folder's variants this is (0 … folderPreviewVariants - 1) */
  variant: number
}

/**
 * The variant to use for a request's `pick` (any whole number; the card's own
 * random one): wraps it into 0 … folderPreviewVariants - 1. Random if missing.
 */
export function variantFor(pick: string | null): number {
  const count = s.folderPreviewVariants
  const n = Number(pick)
  if (pick === null || !Number.isInteger(n) || n < 0) return Math.floor(Math.random() * count)
  return n % count
}

/**
 * Random numbers (0–1) that are always the same for the same `seed`. A
 * variant's pick must not change between requests: the cache name is made
 * from it, so a new pick each time would encode a new preview each time.
 */
function seededRandom(seed: string): () => number {
  // FNV-1a hash of the seed, then mulberry32
  let state = 2166136261
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i)
    state = Math.imul(state, 16777619)
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Up to `max` items of `items`, picked at random and in random order. The same
 * for the same `seed` and `items`, so it only changes when the folder does.
 */
function shuffled(items: string[], max: number, seed: string): string[] {
  const rnd = seededRandom(seed)
  const copy = [...items]
  // Fisher–Yates, stopped once `max` items are placed
  const count = Math.min(max, copy.length)
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rnd() * (copy.length - i))
    ;[copy[i], copy[j]] = [copy[j] as string, copy[i] as string]
  }
  return copy.slice(0, count)
}

/**
 * Picks what to build variant `variant` of the preview of `dir` from, using
 * only the files directly inside it (subfolders don't count). Always the same
 * pick for the same folder contents and variant. null if it has no videos or
 * usable images of its own.
 */
export async function plan(dir: string, variant: number): Promise<Source | null> {
  const files = await filesIn(dir)
  const pick = (items: string[]) => shuffled(items, s.folderPreviewItems, `${dir}#${variant}`)

  const videos = files.filter((f) => isVideoName(path.basename(f)))
  if (videos.length > 0) return { kind: 'videos', items: pick(videos), variant }
  const images = files.filter((f) => isSlideshowImageName(path.basename(f)))
  if (images.length > 0) return { kind: 'images', items: pick(images), variant }
  return null
}

/**
 * Cache name: one per variant; changes when the chosen files change (added,
 * removed or edited) or when the preview settings change
 */
export async function cacheNameFor(dir: string, source: Source): Promise<string> {
  const files = await Promise.all(source.items.map(async (f) => [f, await mtimeSecs(f)]))
  return cacheName(dir, [
    files,
    source.kind,
    source.variant,
    s.folderPreviewItems,
    s.folderPreviewSlicesPerVideo,
    cacheSettings(),
  ])
}

/**
 * Starts of up to `max` slices of a `duration` long video, one at a random
 * moment of each equal part, in time order, so they never overlap. A short
 * video gets fewer (at least 1).
 */
function sliceStarts(duration: number, secs: number, max: number): number[] {
  const n = Math.max(1, Math.min(max, Math.floor(duration / secs)))
  const part = duration / n
  return Array.from({ length: n }, (_, k) =>
    Math.min(k * part + Math.random() * Math.max(0, part - secs), Math.max(0, duration - secs)),
  )
}

/**
 * Every part is cropped to the same square (the card's shape), since the
 * videos and images can all have different sizes
 */
function fitFilter(width: number, scaleFlags: string): string {
  return (
    // non-square pixels → square ones first (stretching one side, as browsers
    // do): the scale + crop below judge the shape by pixels
    `scale='if(gt(sar,1),iw*sar,iw)':'if(lt(sar,1),ih/sar,ih)',setsar=1,` +
    `scale=${width}:${width}:force_original_aspect_ratio=increase:flags=${scaleFlags},` +
    `crop=${width}:${width},setsar=1`
  )
}

/**
 * Makes sure `out` holds the preview described by `source`, encoding it if
 * missing. `hooks` hear its place in line for an encoder, when ffmpeg starts
 * and how far along it is. `signal` stops it, waiting or encoding (rejects
 * with its reason).
 */
export async function ensure(
  out: string,
  source: Source,
  hooks?: BuildHooks,
  signal?: AbortSignal,
): Promise<void> {
  if (await exists(out)) return
  return once(out, () =>
    JOBS.run(async () => {
      if (await exists(out)) return
      hooks?.onEncoding()

      // one consistent set of values for the whole clip
      const secs = s.previewSecs
      const FIT = fitFilter(s.previewWidth, s.scaleFlags)

      const tmp = tempFor(out)
      const args = ['-v', 'error', '-y']
      let graph = ''
      let labels = ''
      let count = 0
      // how long the clip will be, to report progress
      let length = 0

      if (source.kind === 'videos') {
        const inputs: Array<[string, VideoInfo]> = []
        for (const video of source.items) {
          const info = await videoInfo(video)
          if (info) inputs.push([video, info])
        }
        if (inputs.length === 0) throw new MediaError('no-duration', 'could not read any video')
        // reading the videos takes a moment: don't start ffmpeg if cancelled meanwhile
        signal?.throwIfAborted()
        // one common rate (parts must match to be joined): the fastest
        // source's, so no part loses frames
        const fps = Math.max(...inputs.map(([, info]) => info.fps ?? PREVIEW_FALLBACK_FPS))

        // round-robin: one slice of each video per round, until every video
        // gave its share or the clip has folderPreviewItems slices
        const starts = inputs.map(([, info]) =>
          sliceStarts(info.duration, secs, s.folderPreviewSlicesPerVideo),
        )
        for (let round = 0; count < s.folderPreviewItems; round++) {
          let added = false
          for (let i = 0; i < inputs.length && count < s.folderPreviewItems; i++) {
            const start = starts[i]?.[round]
            const input = inputs[i]
            if (start === undefined || !input) continue
            args.push('-ss', start.toFixed(2), '-t', secs.toFixed(2), '-i', input[0])
            graph += `[${count}:v]${FIT},setpts=PTS-STARTPTS,fps=${fps.toFixed(3)},format=yuv420p[v${count}];`
            labels += `[v${count}]`
            count++
            length += Math.max(0, Math.min(secs, input[1].duration - start))
            added = true
          }
          if (!added) break
        }
      } else {
        // each image stays on screen as long as one video slice plays
        const onScreen = secs
        for (const image of source.items) {
          args.push('-loop', '1', '-t', onScreen.toFixed(3), '-i', image)
          graph += `[${count}:v]${FIT},fps=${PREVIEW_FALLBACK_FPS},format=yuv420p[v${count}];`
          labels += `[v${count}]`
          count++
          length += onScreen
        }
      }

      graph += `${labels}concat=n=${count}:v=1:a=0[v]`
      await ffmpegToFile(
        [...args, ...encodeArgs(graph, tmp)],
        tmp,
        out,
        signal,
        hooks && { duration: length, onProgress: hooks.onProgress },
      )
    }, signal, hooks?.onQueued),
  )
}
