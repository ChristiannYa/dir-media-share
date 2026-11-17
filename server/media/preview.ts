// Short looping clip made of slices spread across a video.

import { exists, once, tempFor } from '../cache.ts'
import type { BuildHooks } from '../jobEvents.ts'
import { PREVIEW_FALLBACK_FPS } from '../consts/previews.ts'
import { Semaphore } from '../semaphore.ts'
import { serverSettings as s } from '../settings.ts'
import { MediaError } from './errors.ts'
import { ffmpegToFile } from './ffmpeg.ts'
import { videoInfo, type VideoInfo } from './probe.ts'

/** Shared with folder previews: previewMaxJobs encodes in total */
export const JOBS = new Semaphore(() => s.previewMaxJobs)

/**
 * Every setting that changes the output, for the cache name: changing any of
 * them (Settings) makes new previews instead of reusing old ones
 */
export function cacheSettings() {
  return [
    s.previewClips,
    s.previewSecs,
    s.previewWidth,
    s.previewCrf,
    s.previewPreset,
    s.scaleFlags,
  ]
}

/** Output arguments shared by video and folder previews: encodes `[v]` of `graph` into `out` */
export function encodeArgs(graph: string, out: string): string[] {
  return [
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    s.previewPreset,
    '-crf',
    String(s.previewCrf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    out,
  ]
}

/** Start of slice `i` of `clips`: centred in its 1/n portion of the video */
function sliceStart(duration: number, i: number, clips: number, secs: number): number {
  return Math.max(0, (duration * (i + 0.5)) / clips - secs / 2)
}

/** The source's own frame rate, so slices with odd timestamps still join cleanly */
function outputFps(info: VideoInfo): number {
  return info.fps ?? PREVIEW_FALLBACK_FPS
}

/**
 * Makes sure `out` holds a preview of `video`, encoding it if missing.
 * `hooks` hear its place in line for an encoder, when ffmpeg starts and how
 * far along it is. `signal` stops it, waiting or encoding (rejects with its reason).
 */
export async function ensure(
  video: string,
  out: string,
  hooks?: BuildHooks,
  signal?: AbortSignal,
): Promise<void> {
  if (await exists(out)) return
  return once(out, () =>
    JOBS.run(async () => {
      if (await exists(out)) return
      hooks?.onEncoding()

      // one consistent set of values for the whole clip, even if the
      // settings change while it encodes
      const { previewClips: clips, previewSecs: secs, previewWidth: width, scaleFlags } = s

      const info = await videoInfo(video)
      if (!info) throw new MediaError('no-duration', 'could not read the duration')
      const fps = outputFps(info)
      const tmp = tempFor(out)

      // one input per slice (fast seek), each scaled, then joined
      const args = ['-v', 'error', '-y']
      let graph = ''
      let labels = ''
      // how long the clip will be, to report progress (a short video gives shorter slices)
      let length = 0
      for (let i = 0; i < clips; i++) {
        const start = sliceStart(info.duration, i, clips, secs)
        args.push('-ss', start.toFixed(2), '-t', secs.toFixed(2), '-i', video)
        // height by the shape it plays at (`dar`: non-square pixels applied),
        // then square pixels, so it isn't squashed
        graph += `[${i}:v]scale=${width}:'trunc(ow/dar/2)*2':flags=${scaleFlags},setsar=1,setpts=PTS-STARTPTS,fps=${fps.toFixed(3)}[v${i}];`
        labels += `[v${i}]`
        length += Math.max(0, Math.min(secs, info.duration - start))
      }
      graph += `${labels}concat=n=${clips}:v=1:a=0[v]`

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
