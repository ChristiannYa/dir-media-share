// The compress queue (server/compressQueue.ts): adding videos and photos to
// it (to compress, or the edit dialog's trimmed / cropped copies), stopping
// them, deleting copies again, clearing the ended ones, and the "Compressed!"
// / "Edited!" banner of copies not opened yet (server/compressedNew.ts).

import { isDevMode } from '../appMode.ts'
import { setCompressedSeen } from '../compressedNew.ts'
import {
  cancelCompress,
  clearEndedCompress,
  clearIfAllSeen,
  compressJobs,
  discardCompressJob,
  enqueueCompress,
  enqueueEdit,
  jobIdsIn,
  type CompressRequest,
} from '../compressQueue.ts'
import { readJson, sendJson, type Handler } from '../http.ts'
import { CompressError } from '../media/compress.ts'

/** Largest body POST /api/compress/queue accepts */
const MAX_QUEUE_BODY = 1024 * 1024

/** GET /api/compress/jobs : every job of the queue, oldest first, as `{ jobs }` */
export const listCompressJobs: Handler = async (_req, res) => {
  sendJson(res, { jobs: compressJobs() })
}

/**
 * POST /api/compress/queue with a JSON body `{ files: [{ path, duration?, replace? }] }`:
 * adds them to the queue, which compresses them in the background (with
 * `replace`, the compressed file takes the original's place). Answers
 * `{ queued, refused }`: the new jobs, and the files refused with why.
 */
export const queueCompress: Handler = async (req, res) => {
  let body: unknown
  try {
    body = await readJson(req, MAX_QUEUE_BODY)
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }
  const files = (body as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) return sendJson(res, { error: 'Invalid request' }, 400)
  const requests: CompressRequest[] = files
    .filter((f): f is CompressRequest => typeof (f as CompressRequest)?.path === 'string')
    .map((f) => ({
      path: f.path,
      duration: typeof f.duration === 'number' ? f.duration : null,
      replace: f.replace === true,
    }))
  sendJson(res, await enqueueCompress(requests))
}

/**
 * POST /api/compress/edit with a JSON body `{ path, edit: { start, end, x, y, w, h }, compress?, replace? }`
 * (the edit dialog: the part of the video kept in seconds, the crop in
 * fractions 0–1 of the picture as shown; photos' start / end are unused):
 * adds the trimmed / cropped copy to the queue, which makes it in the
 * background as "<name>_edited.<ext>" and, with `compress: true`, compresses
 * it too, keeping only the compressed one. With `replace: true`, the result
 * takes the original's place instead. Answers `{ job }`.
 */
export const queueEdit: Handler = async (req, res) => {
  let body: unknown
  try {
    body = await readJson(req, MAX_QUEUE_BODY)
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }
  const { path, edit, compress, replace } = (body ?? {}) as {
    path?: unknown
    edit?: unknown
    compress?: unknown
    replace?: unknown
  }
  if (typeof path !== 'string') return sendJson(res, { error: 'Invalid request' }, 400)
  try {
    sendJson(res, { job: await enqueueEdit(path, edit, compress === true, replace === true) })
  } catch (e) {
    if (e instanceof CompressError) return sendJson(res, { error: e.message }, 400)
    console.error('Queueing an edit failed:', e)
    sendJson(res, { error: 'It could not be added to the queue' }, 500)
  }
}

/**
 * POST /api/compress/cancel?id= (one job) | ?folder= (a folder's) | ?all=1 :
 * stops them, waiting or compressing; the copies already saved stay. Answers
 * `{ cancelled }`, how many were stopped.
 */
export const cancelCompressJobs: Handler = async (_req, res, url) => {
  const id = url.searchParams.get('id')
  const folder = url.searchParams.get('folder')
  const ids = id
    ? [id]
    : folder !== null
      ? jobIdsIn(folder)
      : url.searchParams.get('all') === '1'
        ? jobIdsIn()
        : null
  if (!ids) return sendJson(res, { error: 'Say which: id, folder or all' }, 400)
  sendJson(res, { cancelled: cancelCompress(ids) })
}

/**
 * POST /api/compress/discard?id= : deletes the copy that job saved in the
 * last day, for good; the original stays. Answers `{ job }`.
 */
export const discardCompressJobHandler: Handler = async (_req, res, url) => {
  try {
    sendJson(res, { job: await discardCompressJob(url.searchParams.get('id') ?? '') })
  } catch (e) {
    if (e instanceof CompressError) return sendJson(res, { error: e.message }, 403)
    console.error('Discarding a compressed copy failed:', e)
    sendJson(res, { error: 'The copy could not be deleted' }, 500)
  }
}

/**
 * POST /api/compress/clear?folder= : removes the ended jobs of that folder
 * (no folder: of every folder) from the list. Answers `{ removed }`.
 */
export const clearCompressJobs: Handler = async (_req, res, url) => {
  sendJson(res, { removed: clearEndedCompress(url.searchParams.get('folder') ?? undefined) })
}

/**
 * POST /api/compress/seen?path= : the compressed copy was opened in the
 * viewer: its card no longer shows the "Compressed!" banner, on any device.
 * If that was the last copy of the queue's list not opened yet (and nothing
 * is running), the list is cleared, so the top bar's button goes away.
 * Answers `{ seen }` (false if it had none). Dev mode (server/appMode.ts):
 * nothing is saved, and `{ seen: false }`.
 */
export const compressedSeen: Handler = async (req, res, url) => {
  if (isDevMode(req)) return sendJson(res, { seen: false })
  try {
    const rel = url.searchParams.get('path') ?? ''
    const seen = await setCompressedSeen(rel)
    if (seen) clearIfAllSeen(rel)
    sendJson(res, { seen })
  } catch (e) {
    console.error('Saving the new compressed copies failed:', e)
    sendJson(res, { error: 'It could not be saved' }, 500)
  }
}
