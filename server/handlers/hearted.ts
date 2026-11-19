// The "Hearted" section of a folder: its hearted videos and photos
// (subfolders included), in random order.

import { favoritesIn } from '../favorites.ts'
import { sendJson, type Handler } from '../http.ts'
import { entryAt } from '../listing.ts'
import { resolveDir } from '../paths.ts'
import type { Entry } from '../types.ts'

/** Most entries one request may ask for */
const MAX_LIMIT = 100

/**
 * GET /api/hearted?path=&limit= : up to `limit` hearted videos and photos
 * inside the folder (subfolders included), shuffled, as listing entries.
 * Files that are gone are skipped.
 */
export const hearted: Handler = async (_req, res, url) => {
  const rel = url.searchParams.get('path') ?? ''
  const limit = Math.min(MAX_LIMIT, Math.floor(Number(url.searchParams.get('limit')) || 0))
  if (limit <= 0 || !(await resolveDir(rel))) return sendJson(res, [])

  const candidates = favoritesIn(rel)
  // Fisher–Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!]
  }
  const options = { withVideoData: true }
  const found: Entry[] = []
  // a batch at a time (videos are probed), until there are enough
  for (let i = 0; i < candidates.length && found.length < limit; i += limit) {
    const batch = await Promise.all(
      candidates.slice(i, i + limit).map((p) => entryAt(p, options)),
    )
    for (const entry of batch) {
      if (entry && (entry.kind === 'video' || entry.kind === 'image') && found.length < limit) {
        found.push(entry)
      }
    }
  }
  sendJson(res, found)
}
