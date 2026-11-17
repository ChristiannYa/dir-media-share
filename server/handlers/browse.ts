import { isDevMode } from '../appMode.ts'
import { sendJson, type Handler } from '../http.ts'
import { list } from '../listing.ts'
import { resolveDir } from '../paths.ts'

/** GET /api/browse?path= : the contents of a folder (dev mode: without plays or "last viewed") */
export const browse: Handler = async (req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const dir = await resolveDir(rel)
  sendJson(res, dir ? await list(dir, rel, { withVideoData: !isDevMode(req) }) : [])
}
