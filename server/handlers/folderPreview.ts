import { exists, versionedUrl } from '../cache.ts'
import { ROUTE_PREVIEWS } from '../consts/routes.ts'
import { sendJson, sendStatus, type Handler } from '../http.ts'
import { answerPending, trackJob } from '../jobEvents.ts'
import * as folderPreview from '../media/folderPreview.ts'
import { clipFps } from '../media/probe.ts'
import { resolveDir } from '../paths.ts'
import { folderId, markBuilt, previewFile } from '../previewNames.ts'
import { mediaError } from './mediaError.ts'

/**
 * GET /api/folder-preview?path=&pick= : builds one of the folder's preview
 * variants if needed, then answers `{ url, built, fps }` like /api/preview.
 * `pick` (any whole number, random per card) chooses the variant; the same
 * pick always gets the same one, so asking again after a build finishes gets
 * the clip that was built. 404 if the folder has nothing to preview. Takes
 * `&wait=0` like /api/preview. The clip is named dir_<folder>_<n>.mp4, n
 * being the variant + 1 when free (server/previewNames.ts).
 */
export const folderPreviewHandler: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const dir = await resolveDir(rel)
  if (!dir) return sendStatus(res, 404)
  const variant = folderPreview.variantFor(url.searchParams.get('pick'))
  const source = await folderPreview.plan(dir, variant)
  if (!source) return sendStatus(res, 404)

  const version = await folderPreview.cacheNameFor(dir, source)
  const { name, out } = await previewFile('dir', rel, folderId(rel, variant), version, variant + 1)
  const built = !(await exists(out))
  const build = () =>
    trackJob('folder', rel, built, async (hooks, signal) => {
      await folderPreview.ensure(out, source, hooks, signal)
      await markBuilt(name, version)
    })
  if (built && url.searchParams.get('wait') === '0') {
    return answerPending(res, out, `folder preview of ${dir}`, build)
  }
  try {
    await build()
  } catch (e) {
    return mediaError(res, 'folder preview', dir, e)
  }
  sendJson(res, {
    url: await versionedUrl(ROUTE_PREVIEWS, out, name, 'mp4'),
    built,
    fps: await clipFps(out),
  })
}
