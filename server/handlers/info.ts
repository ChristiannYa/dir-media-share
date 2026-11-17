import path from 'node:path'
import { cacheVersion } from '../cacheVersion.ts'
import { sendJson, type Handler } from '../http.ts'
import { SHARE_ROOT } from '../paths.ts'

/**
 * GET /api/info : name of the shared folder, and the cache version shared by
 * every device (server/cacheVersion.ts), which the page puts in its stills' URLs
 */
export const info: Handler = async (_req, res) => {
  sendJson(res, { folder_name: path.basename(SHARE_ROOT), cache_version: cacheVersion() })
}
