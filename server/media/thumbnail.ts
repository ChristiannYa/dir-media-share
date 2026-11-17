// Still JPEG frame of a video.

import { rename } from 'node:fs/promises'
import { exists, once, tempFor } from '../cache.ts'
import { THUMB_FALLBACK_SEEK } from '../consts/thumbnails.ts'
import { serverSettings as s } from '../settings.ts'

/**
 * Every setting that changes the still, for the cache name: changing any of
 * them (Settings) makes new stills instead of reusing old ones
 */
export function cacheSettings() {
  return [s.thumbWidth, s.thumbQuality, s.thumbSampleFrames, s.scaleFlags]
}
import { MediaError } from './errors.ts'
import { ffmpeg } from './ffmpeg.ts'
import { videoDuration } from './probe.ts'

/**
 * Makes sure `out` holds a thumbnail of `video`, generating it if missing.
 *
 * Tries the middle of the video first. If that yields no frame (seek past the
 * end, bad container duration), falls back to the start.
 */
export async function ensure(video: string, out: string): Promise<void> {
  if (await exists(out)) return
  return once(out, async () => {
    if (await exists(out)) return

    const tmp = tempFor(out)
    const duration = await videoDuration(video)
    const middle = duration !== null ? duration / 2 : THUMB_FALLBACK_SEEK
    // `thumbnail` picks a representative frame (no black frames). The height
    // goes by the shape it plays at (`dar`: non-square pixels applied; -2
    // would keep the stored pixels' shape, and browsers ignore the pixel
    // shape in JPEGs). The range conversion is needed because the JPEG
    // encoder only takes full-range YUV
    const filter = `thumbnail=${s.thumbSampleFrames},scale=${s.thumbWidth}:'trunc(ow/dar/2)*2':out_range=pc:flags=${s.scaleFlags},setsar=1,format=yuvj420p`
    const quality = String(s.thumbQuality)

    let lastError = ''
    for (const seek of [middle, null]) {
      const args = ['-v', 'warning', '-y']
      if (seek !== null) args.push('-ss', seek.toFixed(2))
      args.push('-i', video, '-frames:v', '1', '-vf', filter, '-q:v', quality, tmp)

      const result = await ffmpeg(args)
      if (result.code === 0 && (await exists(tmp))) {
        await rename(tmp, out)
        return
      }
      lastError = `exit ${result.code}, seek ${seek ?? 'none'}: ${result.stderr}`
    }
    throw new MediaError('failed', lastError)
  })
}
