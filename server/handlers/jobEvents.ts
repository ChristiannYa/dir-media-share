import { sendJson, type Handler } from '../http.ts'
import { cancelJobs, onCacheCleared, onCompress, onJob } from '../jobEvents.ts'

/** Comment line sent now and then so proxies and browsers keep the stream open */
const KEEPALIVE_MS = 25_000

/**
 * GET /api/jobs/events : a Server-Sent Events stream of preview build progress
 * (queued / encoding / done / failed / cancelled). The page keeps one open for all cards.
 * Also `event: cache` with `{ version }` when a cache was cleared on any
 * device, so every open page drops its own copies (server/cacheVersion.ts).
 * And `event: compress` for every change of the compress queue
 * (server/compressQueue.ts): `{ job }` or `{ removed }`.
 */
export const jobEvents: Handler = async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')

  const stop = onJob((event) => res.write(`data: ${JSON.stringify(event)}\n\n`))
  const stopCache = onCacheCleared((version) =>
    res.write(`event: cache\ndata: ${JSON.stringify({ version })}\n\n`),
  )
  const stopCompress = onCompress((event) =>
    res.write(`event: compress\ndata: ${JSON.stringify(event)}\n\n`),
  )
  const keepalive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS)
  req.on('close', () => {
    stop()
    stopCache()
    stopCompress()
    clearInterval(keepalive)
  })
}

/**
 * POST /api/jobs/cancel?kind=video|folder&path= : the page's card for this
 * preview left the screen before it was built: stops its build, queued or
 * encoding, so the encoders go to the previews on screen. Pages still waiting
 * for it get "cancelled" and ask again. Answers `{ cancelled }`, how many
 * builds were stopped.
 */
export const cancelJob: Handler = async (_req, res, url) => {
  const kind = url.searchParams.get('kind')
  if (kind !== 'video' && kind !== 'folder') return sendJson(res, { error: 'Unknown kind' }, 400)
  sendJson(res, { cancelled: cancelJobs(kind, url.searchParams.get('path') ?? '') })
}
