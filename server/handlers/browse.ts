import { sendJson, type Handler } from '../http.ts'
import { list } from '../listing.ts'
import { resolveDir } from '../paths.ts'

/** GET /api/browse?path= : the contents of a folder */
export const browse: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const dir = await resolveDir(rel)
  sendJson(res, dir ? await list(dir, rel, { withVideoData: true }) : [])
}
