// Saving edited (trimmed / cropped) copies of videos. Photos are cropped in
// the browser and uploaded (src/utils/editImage.ts).

import path from 'node:path'
import { sendJson, type Handler } from '../http.ts'
import { isVideoName } from '../listing.ts'
import { editVideo, EditError, type EditResult, type VideoEdit } from '../media/edit.ts'
import { resolveFile } from '../paths.ts'

/** Videos being edited (real paths), so one can't be edited twice at once */
const busy = new Set<string>()

/** Progress is sent at most this often (and only when the % changes) */
const PROGRESS_EVERY_MS = 250

/** One line of the answer (newline-delimited JSON) */
type EditMessage =
  | { type: 'progress'; fraction: number }
  | ({ type: 'done' } & EditResult)
  | { type: 'error'; error: string }

/**
 * POST /api/file/edit?path=&start=&end=&x=&y=&w=&h= : saves a trimmed and/or
 * cropped copy next to the video as "<name>_edited.mp4" (server/media/edit.ts).
 * The answer is a stream of JSON lines: progress…, then done ({ path, name }
 * of the copy) or error. Closing the request stops it; no copy is kept then.
 */
export const editFile: Handler = async (_req, res, url) => {
  const file = await resolveFile(url.searchParams.get('path') ?? '')
  if (!file) return sendJson(res, { error: 'File not found' }, 404)
  if (!isVideoName(path.basename(file))) {
    return sendJson(res, { error: 'Only videos are edited on the server' }, 415)
  }
  const num = (key: string) => Number(url.searchParams.get(key) ?? NaN)
  const edit: VideoEdit = {
    start: num('start'),
    end: num('end'),
    x: num('x'),
    y: num('y'),
    w: num('w'),
    h: num('h'),
  }
  if (Object.values(edit).some((v) => !Number.isFinite(v))) {
    return sendJson(res, { error: 'Invalid edit' }, 400)
  }
  if (busy.has(file)) return sendJson(res, { error: 'It is already being edited' }, 409)
  busy.add(file)

  // the browser went away (Stop, closed dialog or tab): stop ffmpeg
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // a reverse proxy in front must not hold the lines back
  })
  const send = (message: EditMessage) => {
    if (!res.destroyed) res.write(`${JSON.stringify(message)}\n`)
  }

  let lastPercent = -1
  let lastAt = 0
  const onProgress = (fraction: number) => {
    const percent = Math.floor(fraction * 100)
    const now = Date.now()
    if (percent === lastPercent || now - lastAt < PROGRESS_EVERY_MS) return
    lastPercent = percent
    lastAt = now
    send({ type: 'progress', fraction })
  }

  try {
    send({ type: 'done', ...(await editVideo(file, edit, abort.signal, onProgress)) })
  } catch (e) {
    if (!abort.signal.aborted) {
      if (!(e instanceof EditError)) console.error(`Editing ${file} failed:`, e)
      send({
        type: 'error',
        error: e instanceof EditError ? e.message : 'The video could not be edited',
      })
    }
  } finally {
    busy.delete(file)
    res.end()
  }
}
