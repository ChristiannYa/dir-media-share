import { cacheFile, cacheName, versionedUrl } from '../cache.ts'
import { ROUTE_STORYBOARDS } from '../consts/routes.ts'
import { STORYBOARD_DIR } from '../consts/storyboards.ts'
import { sendJson, sendStatus, type Handler } from '../http.ts'
import { MediaError } from '../media/errors.ts'
import { videoInfo } from '../media/probe.ts'
import * as storyboard from '../media/storyboard.ts'
import { resolveFile } from '../paths.ts'
import { mediaError } from './mediaError.ts'

/**
 * GET /api/storyboard?path= : builds the frame grid if needed and returns its
 * URL and layout as JSON. If the player is closed mid-way the build still
 * finishes (nothing cancels it), so the next open is instant.
 */
export const storyboardHandler: Handler = async (_req, res, url) => {
  const video = await resolveFile(url.searchParams.get('path') ?? '')
  if (!video) return sendStatus(res, 404)

  const info = await videoInfo(video)
  const board = info && storyboard.plan(info)
  if (!board) {
    return mediaError(res, 'storyboard', video, new MediaError('no-duration', 'could not read the size or duration'))
  }

  const name = await cacheName(video, storyboard.cacheSettings(board))
  const out = await cacheFile(STORYBOARD_DIR, name, 'jpg')
  try {
    await storyboard.ensure(video, out, board)
  } catch (e) {
    return mediaError(res, 'storyboard', video, e)
  }
  sendJson(res, { url: await versionedUrl(ROUTE_STORYBOARDS, out, name, 'jpg'), ...board })
}
