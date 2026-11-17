// The images beside the app mode pill (src/components/AppModeButton.vue), one
// per mode, set in Settings → App → App mode images. Each is kept whole in
// APP_MODE_IMAGES_DIR as <mode>.<ext>, with the square part of it the pill
// shows (its frame) in frames.json next to them: the frame can be moved again
// later without uploading the image again, and a GIF keeps moving.

import { randomUUID } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { APP_MODE_IMAGES_DIR } from '../consts/server.ts'
import { readJson, sendJson, sendStatus, serveStatic, type Handler } from '../http.ts'

/** The app modes (src/appMode.ts) */
const MODES = ['goon', 'dev'] as const
type Mode = (typeof MODES)[number]

/** The image formats accepted, and looked for in this order when a mode has more than one */
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']

/** Biggest image accepted (bytes); it's shown at a few dozen pixels */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** A frame is four numbers: anything bigger isn't a real request */
const MAX_FRAME_BODY_BYTES = 1024

const FRAMES_FILE = path.join(APP_MODE_IMAGES_DIR, 'frames.json')

/** The part of an image the pill shows: fractions (0–1) of its width and height */
interface Frame {
  x: number
  y: number
  w: number
  h: number
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** A frame inside the image (a little slack for rounding), or null */
function asFrame(value: unknown): Frame | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, w, h } = value as Record<string, unknown>
  const nums = [x, y, w, h]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const f = { x, y, w, h } as Frame
  const SLACK = 1e-3
  if (f.x < -SLACK || f.y < -SLACK || f.w <= 0 || f.h <= 0) return null
  if (f.x + f.w > 1 + SLACK || f.y + f.h > 1 + SLACK) return null
  return f
}

// ── Frames ──

function loadFrames(): Partial<Record<Mode, Frame>> {
  try {
    const saved: unknown = JSON.parse(readFileSync(FRAMES_FILE, 'utf8'))
    const frames: Partial<Record<Mode, Frame>> = {}
    for (const mode of MODES) {
      const f = asFrame((saved as Record<string, unknown>)[mode])
      if (f) frames[mode] = f
    }
    return frames
  } catch {
    return {} // none saved yet
  }
}

const frames = loadFrames()
let saving = Promise.resolve()

function saveFrames(): Promise<void> {
  const data = JSON.stringify(frames, null, 2) + '\n'
  saving = saving.then(async () => {
    // a temp file, then rename: a crash mid-write can't leave half a file
    await mkdir(APP_MODE_IMAGES_DIR, { recursive: true })
    const tmp = `${FRAMES_FILE}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, FRAMES_FILE)
  })
  return saving
}

// ── Images ──

/** The file names of `mode`'s image, every format found, in EXTENSIONS order */
async function imagesOf(mode: Mode): Promise<string[]> {
  const names = await readdir(APP_MODE_IMAGES_DIR).catch(() => [] as string[])
  // "Goon.PNG" counts too
  return EXTENSIONS.flatMap((ext) => names.filter((n) => n.toLowerCase() === `${mode}${ext}`))
}

/** Stops a body at MAX_IMAGE_BYTES */
class TooBig extends Error {}

async function* capped(source: AsyncIterable<Buffer>) {
  let size = 0
  for await (const chunk of source) {
    size += chunk.length
    if (size > MAX_IMAGE_BYTES) throw new TooBig()
    yield chunk
  }
}

/**
 * GET /api/app-mode-image?mode= : the mode's image, whole (the pill shows its
 * frame). Looked up on every request, so a new one in another format is
 * found right away. 404 if the mode has none.
 */
export const appModeImage: Handler = async (req, res, url) => {
  const mode = url.searchParams.get('mode') ?? ''
  if (!isMode(mode)) return sendStatus(res, 400)
  const [name] = await imagesOf(mode)
  if (!name) return sendStatus(res, 404)
  return serveStatic(req, res, APP_MODE_IMAGES_DIR, `/${encodeURIComponent(name)}`)
}

/**
 * POST /api/app-mode-image?mode=&ext= : the body (the file itself) becomes
 * the mode's image, replacing the one it had in any format. Its old frame is
 * dropped: the app saves the new one right after (POST /api/app-mode-frame).
 */
export const uploadAppModeImage: Handler = async (req, res, url) => {
  const mode = url.searchParams.get('mode') ?? ''
  if (!isMode(mode)) return sendJson(res, { error: 'Unknown mode' }, 400)
  const ext = `.${(url.searchParams.get('ext') ?? '').toLowerCase().replace(/^\./, '')}`
  if (!EXTENSIONS.includes(ext)) {
    return sendJson(res, { error: 'Only PNG, JPG, WebP, GIF or SVG images' }, 415)
  }
  if (Number(req.headers['content-length']) > MAX_IMAGE_BYTES) {
    return sendJson(res, { error: 'That image is over 20 MB' }, 413)
  }

  await mkdir(APP_MODE_IMAGES_DIR, { recursive: true })
  const part = path.join(APP_MODE_IMAGES_DIR, `.${randomUUID()}.part`)
  try {
    await pipeline(req, capped, createWriteStream(part, { flags: 'wx' }))
  } catch (e) {
    await unlink(part).catch(() => {})
    if (e instanceof TooBig) return sendJson(res, { error: 'That image is over 20 MB' }, 413)
    // the browser cancelled: nobody is left to answer
    if (req.destroyed || res.destroyed) return
    console.error(`Saving the ${mode} mode image failed:`, e)
    return sendJson(res, { error: 'The image could not be saved' }, 500)
  }

  // the old image, in whatever format: the new one replaces it
  for (const old of await imagesOf(mode)) {
    await unlink(path.join(APP_MODE_IMAGES_DIR, old)).catch(() => {})
  }
  await rename(part, path.join(APP_MODE_IMAGES_DIR, `${mode}${ext}`))
  if (frames[mode]) {
    delete frames[mode]
    await saveFrames()
  }
  console.log(`New ${mode} mode image`)
  sendJson(res, { ok: true })
}

/**
 * POST /api/app-mode-frame?mode= { x, y, w, h } : the part of the mode's
 * image the pill shows (fractions 0–1 of the image)
 */
export const saveAppModeFrame: Handler = async (req, res, url) => {
  const mode = url.searchParams.get('mode') ?? ''
  if (!isMode(mode)) return sendJson(res, { error: 'Unknown mode' }, 400)
  let frame: Frame | null
  try {
    frame = asFrame(await readJson(req, MAX_FRAME_BODY_BYTES))
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }
  if (!frame) return sendJson(res, { error: 'That frame is outside the image' }, 400)
  frames[mode] = frame
  try {
    await saveFrames()
  } catch (e) {
    console.error(`Saving the ${mode} mode image's frame failed:`, e)
    return sendJson(res, { error: 'The frame could not be saved' }, 500)
  }
  sendJson(res, { ok: true })
}

/**
 * GET /api/app-mode-images : per mode, null if it has no image, or its
 * version (changes with each new image, so the browser loads it again) and
 * its frame (null = the app centers the biggest square)
 */
export const appModeImages: Handler = async (_req, res) => {
  const info: Record<string, { version: number; frame: Frame | null } | null> = {}
  for (const mode of MODES) {
    const [name] = await imagesOf(mode)
    const file = name ? await stat(path.join(APP_MODE_IMAGES_DIR, name)).catch(() => null) : null
    info[mode] = file ? { version: Math.round(file.mtimeMs), frame: frames[mode] ?? null } : null
  }
  sendJson(res, info)
}
