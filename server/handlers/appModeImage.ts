// The images beside the app mode pill (src/components/AppModeButton.vue), one
// per mode, changed from the popup that opens on a tap on the image. Each is
// kept whole in APP_MODE_IMAGES_DIR as <mode>.<ext>, with the round part the
// pill shows (its frame) in frames.json next to them: the frame can be moved
// again later without uploading the image again, and a GIF keeps moving.
//
// An image that's replaced or removed isn't deleted: it goes to the history
// (history/<id>.<ext>, listed in history.json with its frame), where the
// popup can pick it again for either mode, or delete it for good.

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
const HISTORY_DIR = path.join(APP_MODE_IMAGES_DIR, 'history')
const HISTORY_FILE = path.join(APP_MODE_IMAGES_DIR, 'history.json')

/** The part of an image the pill shows: fractions (0–1) of its width and height */
interface Frame {
  x: number
  y: number
  w: number
  h: number
}

/** An image that was replaced or removed */
interface HistoryEntry {
  /** Its file in HISTORY_DIR is <id><ext> */
  id: string
  ext: string
  frame: Frame | null
  /** The mode it was the image of */
  mode: Mode
  /** When it was replaced or removed (ms since 1970) */
  replacedAt: number
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** A frame inside the image (a little slack for rounding), or null */
function asFrame(value: unknown): Frame | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, w, h } = value as Record<string, unknown>
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const f = { x, y, w, h } as Frame
  const SLACK = 1e-3
  if (f.x < -SLACK || f.y < -SLACK || f.w <= 0 || f.h <= 0) return null
  if (f.x + f.w > 1 + SLACK || f.y + f.h > 1 + SLACK) return null
  return f
}

function asHistoryEntry(value: unknown): HistoryEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const e = value as Record<string, unknown>
  if (typeof e.id !== 'string' || !/^[0-9a-f-]{8,36}$/.test(e.id)) return null
  if (typeof e.ext !== 'string' || !EXTENSIONS.includes(e.ext)) return null
  if (typeof e.mode !== 'string' || !isMode(e.mode)) return null
  return {
    id: e.id,
    ext: e.ext,
    frame: asFrame(e.frame),
    mode: e.mode,
    replacedAt: typeof e.replacedAt === 'number' ? e.replacedAt : 0,
  }
}

// ── Saved state: frames.json, history.json ──

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null // none saved yet
  }
}

function loadFrames(): Partial<Record<Mode, Frame>> {
  const saved = readJsonFile(FRAMES_FILE) as Record<string, unknown> | null
  const frames: Partial<Record<Mode, Frame>> = {}
  for (const mode of MODES) {
    const f = asFrame(saved?.[mode])
    if (f) frames[mode] = f
  }
  return frames
}

function loadHistory(): HistoryEntry[] {
  const saved = readJsonFile(HISTORY_FILE)
  if (!Array.isArray(saved)) return []
  return saved.map(asHistoryEntry).filter((e): e is HistoryEntry => e !== null)
}

const frames = loadFrames()
const history = loadHistory()

/** Writes a temp file, then renames it: a crash mid-write can't leave half a file */
async function writeJsonFile(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
  await rename(tmp, file)
}

// Every change goes through here, one at a time: two taps at once (two
// devices) can't move the same file twice or save half of a change
let queue: Promise<unknown> = Promise.resolve()

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

// ── Images ──

/** The file names of `mode`'s image, every format found, in EXTENSIONS order */
async function imagesOf(mode: Mode): Promise<string[]> {
  const names = await readdir(APP_MODE_IMAGES_DIR).catch(() => [] as string[])
  // "Goon.PNG" counts too
  return EXTENSIONS.flatMap((ext) => names.filter((n) => n.toLowerCase() === `${mode}${ext}`))
}

/**
 * Moves `mode`'s image (in whatever format) to the history, with its frame:
 * the mode then has none. Saves history.json and frames.json.
 */
async function archive(mode: Mode) {
  const names = await imagesOf(mode)
  if (names.length > 0) await mkdir(HISTORY_DIR, { recursive: true })
  for (const name of names) {
    const ext = path.extname(name).toLowerCase()
    const id = randomUUID()
    await rename(path.join(APP_MODE_IMAGES_DIR, name), path.join(HISTORY_DIR, `${id}${ext}`))
    history.unshift({ id, ext, frame: frames[mode] ?? null, mode, replacedAt: Date.now() })
  }
  delete frames[mode]
  await writeJsonFile(HISTORY_FILE, history)
  await writeJsonFile(FRAMES_FILE, frames)
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

/** The mode in ?mode=, or null (the request is then answered) */
function modeParam(url: URL, res: Parameters<Handler>[1]): Mode | null {
  const mode = url.searchParams.get('mode') ?? ''
  if (isMode(mode)) return mode
  sendJson(res, { error: 'Unknown mode' }, 400)
  return null
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
 * the mode's image; the one it had goes to the history. The new one starts
 * without a frame: the app saves it right after (POST /api/app-mode-frame).
 */
export const uploadAppModeImage: Handler = async (req, res, url) => {
  const mode = modeParam(url, res)
  if (!mode) return
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

  try {
    await exclusive(async () => {
      await archive(mode)
      await rename(part, path.join(APP_MODE_IMAGES_DIR, `${mode}${ext}`))
    })
  } catch (e) {
    await unlink(part).catch(() => {})
    console.error(`Saving the ${mode} mode image failed:`, e)
    return sendJson(res, { error: 'The image could not be saved' }, 500)
  }
  console.log(`New ${mode} mode image`)
  sendJson(res, { ok: true })
}

/**
 * POST /api/app-mode-frame?mode= { x, y, w, h } : the part of the mode's
 * image the pill shows (fractions 0–1 of the image)
 */
export const saveAppModeFrame: Handler = async (req, res, url) => {
  const mode = modeParam(url, res)
  if (!mode) return
  let frame: Frame | null
  try {
    frame = asFrame(await readJson(req, MAX_FRAME_BODY_BYTES))
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }
  if (!frame) return sendJson(res, { error: 'That frame is outside the image' }, 400)
  const saved = frame
  try {
    await exclusive(async () => {
      frames[mode] = saved
      await writeJsonFile(FRAMES_FILE, frames)
    })
  } catch (e) {
    console.error(`Saving the ${mode} mode image's frame failed:`, e)
    return sendJson(res, { error: 'The frame could not be saved' }, 500)
  }
  sendJson(res, { ok: true })
}

/** POST /api/app-mode-image-remove?mode= : the mode's image goes to the history; it has none after */
export const removeAppModeImage: Handler = async (_req, res, url) => {
  const mode = modeParam(url, res)
  if (!mode) return
  try {
    await exclusive(() => archive(mode))
  } catch (e) {
    console.error(`Removing the ${mode} mode image failed:`, e)
    return sendJson(res, { error: 'The image could not be removed' }, 500)
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

// ── History ──

/** GET /api/app-mode-history : the images replaced or removed, newest first */
export const appModeHistory: Handler = async (_req, res) => {
  sendJson(
    res,
    history.map(({ id, frame, mode, replacedAt }) => ({ id, frame, mode, replacedAt })),
  )
}

/** GET /api/app-mode-history-image?id= : one image of the history, whole */
export const appModeHistoryImage: Handler = async (req, res, url) => {
  const entry = history.find((e) => e.id === url.searchParams.get('id'))
  if (!entry) return sendStatus(res, 404)
  return serveStatic(req, res, HISTORY_DIR, `/${entry.id}${entry.ext}`)
}

/**
 * POST /api/app-mode-image-restore?mode=&id= : the history image `id`
 * becomes the mode's image again, with the frame it had; the one the mode had
 * takes its place in the history
 */
export const restoreAppModeImage: Handler = async (_req, res, url) => {
  const mode = modeParam(url, res)
  if (!mode) return
  const id = url.searchParams.get('id') ?? ''
  try {
    const found = await exclusive(async () => {
      const index = history.findIndex((e) => e.id === id)
      const entry = history[index]
      if (!entry) return false
      history.splice(index, 1)
      // out of the history first, so archiving the current one can't pick it
      const from = path.join(HISTORY_DIR, `${entry.id}${entry.ext}`)
      const parked = path.join(APP_MODE_IMAGES_DIR, `.${entry.id}${entry.ext}.restoring`)
      await rename(from, parked)
      await archive(mode)
      await rename(parked, path.join(APP_MODE_IMAGES_DIR, `${mode}${entry.ext}`))
      if (entry.frame) frames[mode] = entry.frame
      await writeJsonFile(FRAMES_FILE, frames)
      return true
    })
    if (!found) return sendJson(res, { error: 'That image is no longer in the history' }, 404)
  } catch (e) {
    console.error(`Restoring an image for the ${mode} mode failed:`, e)
    return sendJson(res, { error: 'The image could not be restored' }, 500)
  }
  sendJson(res, { ok: true })
}

/** POST /api/app-mode-history-delete?id= : deletes an image of the history for good */
export const deleteAppModeHistoryImage: Handler = async (_req, res, url) => {
  const id = url.searchParams.get('id') ?? ''
  try {
    await exclusive(async () => {
      const index = history.findIndex((e) => e.id === id)
      const entry = history[index]
      if (!entry) return
      history.splice(index, 1)
      await unlink(path.join(HISTORY_DIR, `${entry.id}${entry.ext}`)).catch(() => {})
      await writeJsonFile(HISTORY_FILE, history)
    })
  } catch (e) {
    console.error('Deleting an app mode image from the history failed:', e)
    return sendJson(res, { error: 'The image could not be deleted' }, 500)
  }
  sendJson(res, { ok: true })
}
