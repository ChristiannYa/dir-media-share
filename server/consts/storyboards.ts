// Slider preview in the video player.
//
// One JPEG grid of small frames taken every few seconds, so the player can
// show a preview for any slider position instantly, without seeking.
// Built the first time a video is opened in the player, then cached.
//
// Except STORYBOARD_DIR, these are defaults: the app's Settings popup can
// override them (server/settings.ts), so code reads `serverSettings` instead.

import path from 'node:path'
import { CACHE_ROOT } from './caching.ts'

/** Cache folder for the grid images */
export const STORYBOARD_DIR = path.join(CACHE_ROOT, 'storyboards')
/** Width of each tile (px); the height follows the video's aspect ratio */
export const STORYBOARD_TILE_WIDTH = 160
/** Tiles per row of the grid image */
export const STORYBOARD_COLUMNS = 10
/** Long videos get wider spacing so the grid never has more tiles than this (+1). Higher means more precise previews on long videos, but a bigger image. */
export const STORYBOARD_MAX_TILES = 100
/** Tiles are never closer than this many seconds apart (matters for short videos) */
export const STORYBOARD_MIN_INTERVAL = 2.0
/** JPEG quality: 2 (best, biggest) to 31 (worst, smallest) */
export const STORYBOARD_QUALITY = 5
/**
 * How many storyboards (of different videos) may be built at the same time.
 * Only matters when several videos are opened in quick succession: each build
 * reads its whole video from disk. On an SSD 2–3 is fine; on a hard drive
 * keep 1, since parallel reads make the disk jump between files and slow
 * down both the builds and the video being played.
 */
export const STORYBOARD_MAX_JOBS = 1
