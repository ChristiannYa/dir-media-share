import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { cacheFile, cacheName } from '../cache.ts'
import { thumbCacheControl } from '../cacheControl.ts'
import { THUMB_DIR } from '../consts/thumbnails.ts'
import { sendStatus, type Handler } from '../http.ts'
import * as folderPreview from '../media/folderPreview.ts'
import * as thumbnail from '../media/thumbnail.ts'
import { resolveDir, resolveFile } from '../paths.ts'
import { mediaError } from './mediaError.ts'

/**
 * Answers the still JPEG of `file` (a video: from its middle; an image: the
 * image itself, scaled down), made once and kept in THUMB_DIR. Also for the
 * trash's items (handlers/trash.ts)
 */
export async function sendThumb(res: ServerResponse, file: string, label: string) {
  const out = await cacheFile(THUMB_DIR, await cacheName(file, thumbnail.cacheSettings()), 'jpg')
  try {
    await thumbnail.ensure(file, out)
  } catch (e) {
    return mediaError(res, label, file, e)
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

/** GET /api/thumb?path= : still JPEG from the middle of a video */
export const thumb: Handler = async (_req, res, url) => {
  const video = await resolveFile(url.searchParams.get('path') ?? '')
  if (!video) return sendStatus(res, 404)
  await sendThumb(res, video, 'thumb')
}

/**
 * GET /api/folder-thumb?path=&pick= : still JPEG of a folder's preview, to
 * show (blurred) on its card until the clip plays: the still of the first
 * video (or image) of the variant that `pick` gets, the same pick as
 * /api/folder-preview, so it matches the clip that card will play. Answers
 * right away, even while the clip is still queued or encoding: the pick is
 * worked out without building anything (folderPreview.plan). Shares
 * /api/thumb's cache: a video's still is the same file either way. 404 if
 * the folder has nothing to preview.
 */
export const folderThumb: Handler = async (_req, res, url) => {
  const dir = await resolveDir(url.searchParams.get('path') ?? '')
  if (!dir) return sendStatus(res, 404)
  const source = await folderPreview.plan(dir, folderPreview.variantFor(url.searchParams.get('pick')))
  const first = source?.items[0]
  if (!first) return sendStatus(res, 404)
  await sendThumb(res, first, 'folder thumb')
}
