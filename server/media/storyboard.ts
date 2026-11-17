// Grid of small frames used for the player's slider preview.

import { exists, once, tempFor } from '../cache.ts'
import { Semaphore } from '../semaphore.ts'
import { serverSettings as s } from '../settings.ts'
import type { Storyboard } from '../types.ts'
import { ffmpegToFile } from './ffmpeg.ts'
import type { VideoInfo } from './probe.ts'

const JOBS = new Semaphore(() => s.storyboardMaxJobs)

/** Works out the grid for a video; null if its size or length is unknown */
export function plan(info: VideoInfo): Storyboard | null {
  // the shape it plays at (non-square pixels applied), so the tiles aren't squashed
  const { displayWidth: width, displayHeight: height, duration } = info
  if (!width || !height || duration <= 0) return null
  const interval = Math.max(duration / s.storyboardMaxTiles, s.storyboardMinInterval)
  const count = Math.floor(duration / interval) + 1
  const columns = Math.min(s.storyboardColumns, count)
  const rows = Math.ceil(count / columns)
  const tileWidth = s.storyboardTileWidth
  // keep the aspect ratio; ffmpeg needs an even height
  const tileHeight = Math.max(2, Math.round((tileWidth * height) / width / 2) * 2)
  return {
    interval,
    count,
    columns,
    rows,
    tile_width: tileWidth,
    tile_height: tileHeight,
  }
}

/** Everything that changes the image, for the cache name */
export function cacheSettings(board: Storyboard) {
  return [board.interval, board.columns, board.tile_width, board.tile_height, s.storyboardQuality]
}

/** Makes sure `out` holds the storyboard of `video`, building it if missing */
export async function ensure(video: string, out: string, board: Storyboard): Promise<void> {
  if (await exists(out)) return
  return once(out, () =>
    JOBS.run(async () => {
      if (await exists(out)) return
      const tmp = tempFor(out)
      // `-skip_frame nokey` decodes keyframes only, which makes this fast;
      // `fps` keeps one frame per interval and `tile` packs them into a grid
      const filter =
        `fps=1/${board.interval.toFixed(3)},scale=${board.tile_width}:${board.tile_height},` +
        `tile=${board.columns}x${board.rows}`
      await ffmpegToFile(
        [
          '-v',
          'error',
          '-y',
          '-skip_frame',
          'nokey',
          '-i',
          video,
          '-an',
          '-vf',
          filter,
          '-frames:v',
          '1',
          '-q:v',
          String(s.storyboardQuality),
          tmp,
        ],
        tmp,
        out,
      )
    }),
  )
}
