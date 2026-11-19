// The "Most viewed" and "Most watch time" sections of a folder: its most
// played (or longest watched) videos and photos, or its most played (or
// longest watched) subfolders.

import { sendJson, type Handler } from '../http.ts'
import { entryAt } from '../listing.ts'
import { resolveDir } from '../paths.ts'
import { mostPlayedFolders, mostPlayedIn } from '../plays.ts'
import type { Entry } from '../types.ts'
import { mostWatchedFolders, mostWatchedIn } from '../watchTime.ts'

/** Most entries one request may ask for */
const MAX_LIMIT = 100

/**
 * GET /api/most-played?path=&limit=&kind=media|folders&by=plays|time : as
 * listing entries, the highest first,
 * - media (default): the `limit` videos and photos inside the folder
 *   (subfolders included) played most in the viewer
 * - folders: the `limit` folders directly inside it whose videos and photos
 *   (at any depth) were played most, all added up
 * `by`: plays (default, server/plays.ts) or time watched (server/watchTime.ts).
 * Files and folders that are gone are skipped.
 */
export const mostPlayed: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const limit = Math.min(MAX_LIMIT, Math.floor(Number(url.searchParams.get('limit')) || 0))
  const folders = url.searchParams.get('kind') === 'folders'
  const byTime = url.searchParams.get('by') === 'time'
  if (limit <= 0 || !(await resolveDir(rel))) return sendJson(res, [])

  const ranked = byTime
    ? folders
      ? mostWatchedFolders(rel)
      : mostWatchedIn(rel)
    : folders
      ? mostPlayedFolders(rel)
      : mostPlayedIn(rel)
  const candidates = ranked.map(([p]) => p)
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
