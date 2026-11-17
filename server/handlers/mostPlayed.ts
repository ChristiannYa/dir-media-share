// The "Most played" section of a folder: its most played videos and photos,
// or its most played subfolders.

import { isDevMode } from '../appMode.ts'
import { sendJson, type Handler } from '../http.ts'
import { entryAt } from '../listing.ts'
import { resolveDir } from '../paths.ts'
import { mostPlayedFolders, mostPlayedIn } from '../plays.ts'
import type { Entry } from '../types.ts'

/** Most entries one request may ask for */
const MAX_LIMIT = 100

/**
 * GET /api/most-played?path=&limit=&kind=media|folders : as listing entries,
 * most played first,
 * - media (default): the `limit` videos and photos inside the folder
 *   (subfolders included) played most in the viewer
 * - folders: the `limit` folders directly inside it whose videos and photos
 *   (at any depth) were played most, all added up
 * Files and folders that are gone are skipped. Dev mode (server/appMode.ts): none.
 */
export const mostPlayed: Handler = async (req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const limit = Math.min(MAX_LIMIT, Math.floor(Number(url.searchParams.get('limit')) || 0))
  const folders = url.searchParams.get('kind') === 'folders'
  if (isDevMode(req) || limit <= 0 || !(await resolveDir(rel))) return sendJson(res, [])

  const candidates = (folders ? mostPlayedFolders(rel) : mostPlayedIn(rel)).map(([p]) => p)
  const wanted = (entry: Entry | null): entry is Entry =>
    entry !== null && (folders ? entry.kind === 'folder' : entry.kind !== 'folder')
  const found: Entry[] = []
  // a batch at a time (videos are probed, folders scanned), until there are enough
  for (let i = 0; i < candidates.length && found.length < limit; i += limit) {
    const batch = await Promise.all(
      candidates.slice(i, i + limit).map((p) => entryAt(p, { withVideoData: true })),
    )
    for (const entry of batch) if (wanted(entry) && found.length < limit) found.push(entry)
  }
  sendJson(res, found)
}
