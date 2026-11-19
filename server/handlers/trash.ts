// The app's trash view (src/components/TrashDialog.vue): what was deleted from
// the shared folder, put back where it was, or deleted for good. Only items
// that came from the shared folder are seen (server/trash.ts).

import { lstat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { cacheFile, cacheName } from '../cache.ts'
import { THUMB_DIR } from '../consts/thumbnails.ts'
import { sendJson, sendStatus, serveStatic, type Handler } from '../http.ts'
import * as thumbnail from '../media/thumbnail.ts'
import { sendThumb } from './thumb.ts'
import {
  deleteFromTrash,
  listTrash,
  restoreFromTrash,
  trashedFile,
  trashItem,
  TrashError,
} from '../trash.ts'

/** GET /api/trash : what was deleted from the shared folder, the last first, as `{ items }` */
export const listTrashHandler: Handler = async (_req, res) => {
  sendJson(res, { items: await listTrash() })
}

/**
 * GET /api/trash/item?id= : the trashed file itself (photos and videos are
 * shown before restoring them; Range requests work, for seeking)
 */
export const trashItemFile: Handler = async (req, res, url) => {
  const item = await trashItem(url.searchParams.get('id') ?? '')
  if (!item || (item.kind !== 'video' && item.kind !== 'image')) return sendStatus(res, 404)
  const file = trashedFile(item)
  // a regular file only: a symlink in the trash is never followed
  if (!(await lstat(file).catch(() => null))?.isFile()) return sendStatus(res, 404)
  return serveStatic(req, res, path.dirname(file), `/${encodeURIComponent(path.basename(file))}`)
}

/**
 * GET /api/trash/thumb?id= : the still of a trashed photo / video (a video's
 * from its middle), made and kept like the gallery's (handlers/thumb.ts)
 */
export const trashItemThumb: Handler = async (_req, res, url) => {
  const item = await trashItem(url.searchParams.get('id') ?? '')
  if (!item || (item.kind !== 'video' && item.kind !== 'image')) return sendStatus(res, 404)
  const file = trashedFile(item)
  // a regular file only: a symlink in the trash is never followed
  if (!(await lstat(file).catch(() => null))?.isFile()) return sendStatus(res, 404)
  await sendThumb(res, file, 'trash thumb')
}

/** The cached still of a trashed item, so deleting it for good leaves none behind */
async function forgetThumb(id: string) {
  const item = await trashItem(id)
  if (!item || (item.kind !== 'video' && item.kind !== 'image')) return
  const out = await cacheFile(
    THUMB_DIR,
    await cacheName(trashedFile(item), thumbnail.cacheSettings()),
    'jpg',
  )
  await unlink(out).catch(() => {})
}

/**
 * POST /api/trash/restore?id= : puts it back where it was deleted from (as
 * "name (2)" if that name is taken now). Answers `{ path }`, where it is now
 */
export const restoreTrashHandler: Handler = async (_req, res, url) => {
  try {
    sendJson(res, { path: await restoreFromTrash(url.searchParams.get('id') ?? '') })
  } catch (e) {
    if (e instanceof TrashError) return sendJson(res, { error: e.message }, 400)
    console.error('Restoring from the trash failed:', e)
    sendJson(res, { error: 'It could not be restored' }, 500)
  }
}

/** POST /api/trash/delete?id= : deletes it for good. Answers `{ deleted: true }` */
export const deleteTrashHandler: Handler = async (_req, res, url) => {
  try {
    // while the file is still there: the still's cache name is worked out from it
    await forgetThumb(url.searchParams.get('id') ?? '').catch(() => {})
    await deleteFromTrash(url.searchParams.get('id') ?? '')
    sendJson(res, { deleted: true })
  } catch (e) {
    if (e instanceof TrashError) return sendJson(res, { error: e.message }, 400)
    console.error('Deleting from the trash failed:', e)
    sendJson(res, { error: 'It could not be deleted' }, 500)
  }
}
