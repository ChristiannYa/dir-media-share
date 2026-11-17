// Small HTTP helpers: responses and static files with Range support.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>

export function sendStatus(res: ServerResponse, status: number) {
  res.writeHead(status).end()
}

export function sendJson(res: ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Reads a JSON request body; throws if it's bigger than `maxBytes` or not JSON */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('too big')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 307: the browser repeats the same request at `location` */
export function redirect(res: ServerResponse, location: string) {
  res.writeHead(307, { Location: location }).end()
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

type ByteRange = { start: number; end: number }

/** Parses a single `bytes=start-end` range; null to send the whole file */
function parseRange(header: string, size: number): ByteRange | null | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null // multiple ranges etc.: just send everything
  const [, from = '', to = ''] = match
  if (from === '') {
    // "bytes=-500": the last 500 bytes
    const suffix = Number(to)
    if (!suffix) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/**
 * Serves `urlPath` (still URL-encoded) from the folder `root`. Folders serve
 * their index.html. Supports Range requests, which video seeking needs.
 * `cacheControl`, if given, tells the browser how long it may keep the file.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  urlPath: string,
  cacheControl?: string,
) {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return sendStatus(res, 400)
  }
  if (decoded.includes('\0')) return sendStatus(res, 400)

  const rootAbs = path.resolve(root)
  let file = path.join(rootAbs, decoded)
  // path.join resolves "..", so anything outside root is an escape attempt
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return sendStatus(res, 403)

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) return sendStatus(res, 404)

  const headers = {
    'Content-Type': mimeType(file),
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
  }

  const since = req.headers['if-modified-since']
  if (since && !req.headers.range && Math.floor(info.mtimeMs / 1000) <= Date.parse(since) / 1000) {
    res.writeHead(304, headers).end()
    return
  }

  const range = req.headers.range ? parseRange(req.headers.range, info.size) : null
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end()
    return
  }

  const start = range?.start ?? 0
  const end = range?.end ?? info.size - 1
  const length = info.size === 0 ? 0 : end - start + 1
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Content-Length': length,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  })
  if (req.method === 'HEAD' || length === 0) {
    res.end()
    return
  }

  const stream = createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  // stop reading when the browser cancels (e.g. it seeks elsewhere)
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
