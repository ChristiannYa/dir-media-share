import { sendJson, sendStatus, type Handler } from '../http.ts'
import { purgeFolder } from '../media/purge.ts'
import { resolveDir } from '../paths.ts'

/**
 * POST /api/cache/clear?path= : deletes the cached stills, previews and
 * storyboards of a folder, its subfolders and every video in them
 */
export const clearCache: Handler = async (_req, res, url) => {
  const dir = await resolveDir(url.searchParams.get('path') ?? '')
  if (!dir) return sendStatus(res, 404)

  const removed = await purgeFolder(dir)
  console.log(`Cleared ${removed} cached files under ${dir}`)
  sendJson(res, { removed })
}
