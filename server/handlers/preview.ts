import { cacheName, exists, versionedUrl } from '../cache.ts'
import { ROUTE_PREVIEWS } from '../consts/routes.ts'
import { sendJson, sendStatus, type Handler } from '../http.ts'
import { answerPending, trackJob } from '../jobEvents.ts'
import * as preview from '../media/preview.ts'
import { clipFps } from '../media/probe.ts'
import { resolveFile } from '../paths.ts'
import { folderOf, markBuilt, previewFile, videoId } from '../previewNames.ts'
import { mediaError } from './mediaError.ts'

/**
 * GET /api/preview?path= : builds the preview clip if needed, then answers
 * `{ url, built, fps }`: where to download it, whether it was encoded just now
 * (false = it was already in the server's cache), and its frame rate (null if
 * unknown). Progress while building is announced on /api/jobs/events.
 * With `&wait=0`, a preview that isn't built yet answers 202 `{ pending: true }`
 * right away instead (see answerPending). The clip is named
 * vid_<folder>_<n>.mp4 (server/previewNames.ts).
 */
export const previewHandler: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const video = await resolveFile(rel)
  if (!video) return sendStatus(res, 404)

  const version = await cacheName(video, preview.cacheSettings())
  const { name, out } = await previewFile('vid', folderOf(rel), videoId(rel), version)
  const built = !(await exists(out))
  const build = () =>
    trackJob('video', rel, built, async (hooks, signal) => {
      await preview.ensure(video, out, hooks, signal)
      await markBuilt(name, version)
    })
  if (built && url.searchParams.get('wait') === '0') {
    return answerPending(res, out, `preview of ${video}`, build)
  }
  try {
    await build()
  } catch (e) {
    return mediaError(res, 'preview', video, e)
  }
  sendJson(res, {
    url: await versionedUrl(ROUTE_PREVIEWS, out, name, 'mp4'),
    built,
    fps: await clipFps(out),
  })
}
