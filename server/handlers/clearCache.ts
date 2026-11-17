import { bumpCacheVersion } from '../cacheVersion.ts'
import { sendJson, sendStatus, type Handler } from '../http.ts'
import { purgeAll, purgeFolder } from '../media/purge.ts'
import { resolveDir } from '../paths.ts'

/**
 * POST /api/cache/clear?path= : deletes the cached stills, previews and
 * storyboards of a folder, its subfolders and every video in them.
 * POST /api/cache/clear?all=1 : empties the whole cache instead, every folder at once.
 * Either way the shared cache version goes up (server/cacheVersion.ts), so
 * every device, not only this one, stops showing its own cached copies.
 * Answers `{ removed, version }`: how many files were deleted, and the new version.
 */
export const clearCache: Handler = async (_req, res, url) => {
  let removed: number
  if (url.searchParams.get('all') === '1') {
    removed = await purgeAll()
    console.log(`Cleared the whole cache: ${removed} files`)
  } else {
    const dir = await resolveDir(url.searchParams.get('path') ?? '')
    if (!dir) return sendStatus(res, 404)
    removed = await purgeFolder(dir)
    console.log(`Cleared ${removed} cached files under ${dir}`)
  }
  const version = await bumpCacheVersion()
  sendJson(res, { removed, version })
}
