// Saving playable MP4 copies of MPEG-TS videos (the red "TS" badge).

import { sendJson, type Handler } from '../http.ts'
import { fixTs, TsFixError, type TsFixResult } from '../media/tsFix.ts'
import { resolveFile } from '../paths.ts'

/** Videos being fixed (real paths), so one can't be fixed twice at once */
const busy = new Set<string>()

/** Progress is sent at most this often (and only when the % changes) */
const PROGRESS_EVERY_MS = 250

/** One line of the answer (newline-delimited JSON) */
type TsFixMessage =
  | { type: 'progress'; fraction: number }
  | ({ type: 'done' } & TsFixResult)
  | { type: 'error'; error: string }

/**
 * POST /api/file/fix-ts?path= : remuxes an MPEG-TS video into a real MP4
 * saved next to it as "<name>_ts_fix.mp4" (server/media/tsFix.ts). The answer
 * is a stream of JSON lines: progress…, then done ({ path, name } of the
 * copy) or error. Closing the request stops it; no copy is kept then.
 */
export const fixTsFile: Handler = async (_req, res, url) => {
  const file = await resolveFile(url.searchParams.get('path') ?? '')
  if (!file) return sendJson(res, { error: 'File not found' }, 404)
  if (busy.has(file)) return sendJson(res, { error: 'It is already being fixed' }, 409)
  busy.add(file)

  // the browser went away: stop ffmpeg
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // a reverse proxy in front must not hold the lines back
  })
  const send = (message: TsFixMessage) => {
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
    send({ type: 'done', ...(await fixTs(file, abort.signal, onProgress)) })
  } catch (e) {
    if (!abort.signal.aborted) {
      if (!(e instanceof TsFixError)) console.error(`Fixing ${file} failed:`, e)
      send({
        type: 'error',
        error: e instanceof TsFixError ? e.message : 'The video could not be fixed',
      })
    }
  } finally {
    busy.delete(file)
    res.end()
  }
}
