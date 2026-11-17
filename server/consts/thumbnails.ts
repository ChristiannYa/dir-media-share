// Still frame on each video card.
//
// THUMB_WIDTH, THUMB_SAMPLE_FRAMES and THUMB_QUALITY are defaults: the app's
// Settings popup can override them (server/settings.ts).

import path from 'node:path'
import { CACHE_ROOT } from './caching.ts'

/**
 * Cache folder; files are named after the video, its modification time and
 * the THUMB_* settings, so editing a video or a setting makes a new one
 */
export const THUMB_DIR = path.join(CACHE_ROOT, 'thumbs')
/**
 * Width (px); the height follows the video's aspect ratio. Phones draw ~3
 * pixels per CSS pixel, so a ~220px card needs ~660px to look sharp.
 */
export const THUMB_WIDTH = 720
/** Frames the `thumbnail` filter compares to pick a representative one (skips black frames). Higher picks better but takes longer. */
export const THUMB_SAMPLE_FRAMES = 150
/** JPEG quality: 2 (best, biggest) to 31 (worst, smallest) */
export const THUMB_QUALITY = 2
/** Seek position (seconds) when the duration can't be read */
export const THUMB_FALLBACK_SEEK = 1.0
// How long the browser keeps stills: the "Browser cache" setting (server/cacheControl.ts)
