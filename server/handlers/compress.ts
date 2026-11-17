// Saving compressed copies of videos and photos, and deleting them again.

import path from 'node:path'
import { sendJson, type Handler } from '../http.ts'
import { isVideoName } from '../listing.ts'
import { compressVideo, CompressError, discardCompressed } from '../media/compress.ts'
import { compressImage, isCompressibleImageName } from '../media/compressImage.ts'
import { resolveFile } from '../paths.ts'

/** Files being compressed (real paths), so one can't be compressed twice at once */
const busy = new Set<string>()

/** One line of the compress answer (newline-delimited JSON) */
type CompressMessage =
  | { type: 'queued' }
  | { type: 'started' }
  | { type: 'progress'; fraction: number; speed: number | null }
  | {
      type: 'done'
      before: number
      after: number
      compressed: boolean
      path?: string
      name?: string
      note?: string
    }
  | { type: 'error'; error: string }

/**
 * POST /api/file/compress?path= : saves a compressed copy of a video
 * (server/media/compress.ts) or a photo (server/media/compressImage.ts) next
 * to it. Takes as long as the encode, so the answer is a stream of JSON
 * lines: queued, started, progress… (videos only), then done or error.
 * Closing the request stops it; no copy is kept then.
 */
export const compressFile: Handler = async (_req, res, url) => {
  const file = await resolveFile(url.searchParams.get('path') ?? '')
  if (!file) return sendJson(res, { error: 'File not found' }, 404)
  const name = path.basename(file)
  const isImage = isCompressibleImageName(name)
  if (!isImage && !isVideoName(name)) {
    return sendJson(res, { error: 'Only videos and photos can be compressed' }, 415)
  }
  if (busy.has(file)) return sendJson(res, { error: 'It is already being compressed' }, 409)
  busy.add(file)

  // the browser went away (Stop, Cancel, closed tab): stop ffmpeg
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // a reverse proxy in front must not hold the lines back
  })
  const send = (message: CompressMessage) => {
    if (!res.destroyed) res.write(`${JSON.stringify(message)}\n`)
  }

  send({ type: 'queued' })
  try {
    const result = await (isImage ? compressImage : compressVideo)(file, {
      signal: abort.signal,
      onStart: () => send({ type: 'started' }),
      onProgress: (p) => send({ type: 'progress', fraction: p.fraction, speed: p.speed }),
    })
    send({ type: 'done', ...result })
  } catch (e) {
    if (!abort.signal.aborted) {
      if (!(e instanceof CompressError)) console.error(`Compressing ${file} failed:`, e)
      send({
        type: 'error',
        error: e instanceof CompressError ? e.message : 'It could not be compressed',
      })
    }
  } finally {
    busy.delete(file)
    res.end()
  }
}

/**
 * POST /api/file/compress/discard?path= : deletes a copy a compression saved
 * in the last day (the compress dialog's Cancel). Any other file is refused.
 */
export const discardCompressedFile: Handler = async (_req, res, url) => {
  const file = await resolveFile(url.searchParams.get('path') ?? '')
  if (!file) return sendJson(res, { error: 'File not found' }, 404)
  try {
    if (!(await discardCompressed(file))) {
      return sendJson(res, { error: 'Only copies that were just compressed can be discarded' }, 403)
    }
  } catch (e) {
    console.error(`Discarding the compressed copy ${file} failed:`, e)
    return sendJson(res, { error: 'The copy could not be deleted' }, 500)
  }
  sendJson(res, { discarded: true })
}
