// The compress queue (server/compressQueue.ts): adding videos and photos to
// it, stopping them, deleting copies again, clearing the ended ones, and the
// "Compressed!" banner of copies not opened yet (server/compressedNew.ts).

import { setCompressedSeen } from '../compressedNew.ts'
import {
  cancelCompress,
  clearEndedCompress,
  compressJobs,
  discardCompressJob,
  enqueueCompress,
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
 * POST /api/compress/queue with a JSON body `{ files: [{ path, duration? }] }`:
 * adds them to the queue, which compresses them in the background. Answers
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
    .map((f) => ({ path: f.path, duration: typeof f.duration === 'number' ? f.duration : null }))
  sendJson(res, await enqueueCompress(requests))
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
 * Answers `{ seen }` (false if it had none).
 */
export const compressedSeen: Handler = async (_req, res, url) => {
  try {
    sendJson(res, { seen: await setCompressedSeen(url.searchParams.get('path') ?? '') })
  } catch (e) {
    console.error('Saving the new compressed copies failed:', e)
    sendJson(res, { error: 'It could not be saved' }, 500)
  }
}
