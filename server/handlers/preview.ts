import { exists, versionedUrl } from '../cache.ts'
import { ROUTE_PREVIEWS } from '../consts/routes.ts'
import { sendJson, sendStatus, type Handler } from '../http.ts'
import { answerPending, trackJob } from '../jobEvents.ts'
import * as preview from '../media/preview.ts'
import { cachedVideoInfo } from '../media/probe.ts'
import { resolveFile } from '../paths.ts'
import { folderOf, markBuilt, previewFile, videoId } from '../previewNames.ts'
import { mediaError } from './mediaError.ts'

/**
 * Most a whole-video clip's length may differ from its video's (seconds):
 * re-encoding at a set frame rate can round the end by a frame or so
 */
const WHOLE_TOLERANCE_S = 0.5

/**
 * GET /api/preview?path= : builds the preview clip if needed, then answers
 * `{ url, built, fps, whole }`: where to download it, whether it was encoded
 * just now (false = it was already in the server's cache), its frame rate
 * (null if unknown), and whether the clip is the whole video (a short one)
 * rather than slices of it. Progress while building is announced on
 * /api/jobs/events.
 * With `&wait=0`, a preview that isn't built yet answers 202 `{ pending: true }`
 * right away instead (see answerPending). The clip is named
 * vid_<folder>_<n>.mp4 (server/previewNames.ts).
 */
export const previewHandler: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const video = await resolveFile(rel)
  if (!video) return sendStatus(res, 404)

  const version = await preview.previewVersion(video)
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
  // measured on the finished clip, not guessed from the settings: an old
  // sliced clip of a short video doesn't count as whole
  const [clip, source] = await Promise.all([cachedVideoInfo(out), cachedVideoInfo(video)])
  sendJson(res, {
    url: await versionedUrl(ROUTE_PREVIEWS, out, name, 'mp4'),
    built,
    fps: clip?.fps ?? null,
    whole:
      clip !== null &&
      source !== null &&
      Math.abs(clip.duration - source.duration) <= WHOLE_TOLERANCE_S,
  })
}
