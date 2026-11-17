import { readFile } from 'node:fs/promises'
import { cacheFile, cacheName } from '../cache.ts'
import { thumbCacheControl } from '../cacheControl.ts'
import { THUMB_DIR } from '../consts/thumbnails.ts'
import { sendStatus, type Handler } from '../http.ts'
import * as thumbnail from '../media/thumbnail.ts'
import { resolveFile } from '../paths.ts'
import { mediaError } from './mediaError.ts'

/** GET /api/thumb?path= : still JPEG from the middle of a video */
export const thumb: Handler = async (_req, res, url) => {
  const video = await resolveFile(url.searchParams.get('path') ?? '')
  if (!video) return sendStatus(res, 404)

  const out = await cacheFile(THUMB_DIR, await cacheName(video, thumbnail.cacheSettings()), 'jpg')
  try {
    await thumbnail.ensure(video, out)
  } catch (e) {
    return mediaError(res, 'thumb', video, e)
  }

  const bytes = await readFile(out).catch(() => null)
  if (!bytes) return sendStatus(res, 404)
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': bytes.length,
    'Cache-Control': thumbCacheControl(),
  })
  res.end(bytes)
}
