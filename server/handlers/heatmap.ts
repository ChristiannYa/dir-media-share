// A video's "most watched parts", drawn over the player's slider like
// YouTube's heatmap (server/heatmap.ts).

import path from 'node:path'
import { isDevMode } from '../appMode.ts'
import { HEATMAP_BINS, HEATMAP_MAX_ADD, HEATMAP_MAX_BODY_BYTES } from '../consts/heatmap.ts'
import { addWatched, heatmapOf } from '../heatmap.ts'
import { readJson, sendJson, sendStatus, type Handler } from '../http.ts'
import { isVideoName } from '../listing.ts'
import { resolveFile } from '../paths.ts'

/**
 * GET /api/heatmap?path= : `{ counts }`, how many times each part was watched
 * (null if never, and always in dev mode: server/appMode.ts)
 */
export const getHeatmap: Handler = async (req, res, url) => {
  // kept by the path the listing shows (like plays and views)
  const rel = url.searchParams.get('path') ?? ''
  sendJson(res, { counts: isDevMode(req) ? null : heatmapOf(rel) })
}

/**
 * POST /api/heatmap?path= : the body is a JSON array of HEATMAP_BINS whole
 * numbers, how many times each part was just watched; they're added up.
 * Answers `{ counts }`, the new totals. Dev mode (server/appMode.ts): nothing
 * is saved, and `{ counts: null }`.
 */
export const postHeatmap: Handler = async (req, res, url) => {
  if (isDevMode(req)) return sendJson(res, { counts: null })
  const rel = url.searchParams.get('path') ?? ''
  const file = await resolveFile(rel)
  if (!file || !isVideoName(path.basename(file))) return sendStatus(res, 404)

  let counts: unknown
  try {
    counts = await readJson(req, HEATMAP_MAX_BODY_BYTES)
  } catch {
    return sendJson(res, { error: 'Expected a JSON array' }, 400)
  }
  const ok =
    Array.isArray(counts) &&
    counts.length === HEATMAP_BINS &&
    counts.every((n) => Number.isInteger(n) && n >= 0 && n <= HEATMAP_MAX_ADD)
  if (!ok) {
    return sendJson(
      res,
      { error: `Expected ${HEATMAP_BINS} whole numbers from 0 to ${HEATMAP_MAX_ADD}` },
      400,
    )
  }
  try {
    sendJson(res, { counts: await addWatched(rel, counts) })
  } catch (e) {
    console.error('Saving the heatmap failed:', e)
    sendJson(res, { error: 'The watched parts could not be saved' }, 500)
  }
}
