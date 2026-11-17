// Auto-playing clip on each video card (folder previews reuse these too).
//
// Each preview is PREVIEW_CLIPS slices of PREVIEW_SECS seconds, evenly spread
// across the video and joined into one muted clip, at the video's own speed.
// Changing any of these makes new previews (old ones are not reused).
//
// The speed previews play at isn't baked in: each device sets it as a
// playback rate (the client's "Preview speed" setting), so it changes
// instantly, without encoding anything again.
//
// Except PREVIEW_DIR and PREVIEW_FALLBACK_FPS, these are defaults: the app's
// Settings popup can override them (server/settings.ts), so code reads them
// from `serverSettings` instead.

import path from 'node:path'
import { CACHE_ROOT } from './caching.ts'

/** Cache folder for the finished clips (video and folder previews) */
export const PREVIEW_DIR = path.join(CACHE_ROOT, 'previews')
/**
 * Which name each preview clip has and which version of it was built
 * (server/previewNames.ts). Outside PREVIEW_DIR, so cleaning the cache never
 * deletes it.
 */
export const PREVIEW_NAMES_FILE = path.join(CACHE_ROOT, 'preview-names.json')
/** Longest the folder part of a preview's name gets, in bytes (file names may have 255) */
export const PREVIEW_NAME_FOLDER_MAX_BYTES = 150
/** Number of slices; more means a longer loop that shows more of the video */
export const PREVIEW_CLIPS = 8
/** Length of each slice in seconds of the original video */
export const PREVIEW_SECS = 3.0
/**
 * Previews are all requested at once when a folder opens; at most this many
 * (video and folder previews together) encode at the same time. Each job
 * already keeps several CPU cores busy, so raising this only helps if the CPU
 * isn't fully used: check `htop` while a new folder builds its previews.
 */
export const PREVIEW_MAX_JOBS = 4
/**
 * Width (px); the height follows the video's aspect ratio (folder previews
 * are a square of this size). Phones draw ~3 pixels per CSS pixel, so a
 * ~220px card needs ~660px to look sharp. Encode time and file size grow with
 * the pixel count: 720 is ~2.25x the cost of 480, 960 is ~4x.
 */
export const PREVIEW_WIDTH = 720
/** Source frame rate assumed when ffprobe can't report a usable one */
export const PREVIEW_FALLBACK_FPS = 30.0
/** x264 quality (CRF): lower is better and bigger. ~18 looks near-lossless, 23 is x264's default, 28 is visibly soft. */
export const PREVIEW_CRF = 16
/**
 * x264 speed/size trade-off: ultrafast … veryfast … medium … veryslow.
 * Slower presets give smaller files at the same quality but encode longer.
 */
export const PREVIEW_PRESET = 'veryfast'
