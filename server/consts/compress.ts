// Compressing videos (e.g. screen recordings, which are saved at a very high
// bitrate): same resolution, frame timing and audio, smaller file.
//
// The original is never touched: the result is saved next to it as a new
// file, named after the settings used, e.g. "clip [x264 crf20 slow].mp4".
//
// Photos too (server/media/compressImage.ts), like TinyPNG: same format and
// size in pixels, each made as small as it can get without a visible change.
//
// Except the *_MAX_JOBS and COMPRESS_DISCARD_WINDOW_MS, these are defaults:
// the app's Settings popup can override them (server/settings.ts), so code
// reads them from `serverSettings`.

/**
 * x264 quality (CRF) for .mp4 / .mov / .mkv: lower is better and bigger. ~18
 * looks near-lossless, 20 is hard to tell apart from the original, 23 is
 * x264's default
 */
export const COMPRESS_CRF = 20
/** x264 speed/size trade-off; slower makes smaller files at the same quality */
export const COMPRESS_PRESET = 'slow'
/**
 * VP9 quality (CRF) for .webm, which can't hold H.264: lower is better and
 * bigger. ~31 is the usual pick for 1080p; its scale isn't x264's
 */
export const COMPRESS_VP9_CRF = 31
/**
 * The compressed copy is only saved if it's at least this many percent
 * smaller than the original; otherwise it's thrown away (re-encoding an
 * already-small video can even make it bigger)
 */
export const COMPRESS_MIN_SAVING = 10
/**
 * Highest JPEG quality a compressed photo keeps (jpegoptim --max). Photos
 * saved above it are re-encoded at it; ones already at or below it are only
 * optimized losslessly, so each photo gets what it needs. ~80–85 is hard to
 * tell from the original
 */
export const COMPRESS_JPEG_QUALITY = 82
/**
 * PNG quality (pngquant, 0–100): its colors are reduced to at most 256,
 * picked for each image, aiming for this quality. If it can't stay within 20
 * of it, the image would visibly change, so no copy is made
 */
export const COMPRESS_PNG_QUALITY = 85
/** WebP quality (cwebp, 0–100) */
export const COMPRESS_WEBP_QUALITY = 80
/**
 * Photos compressed at the same time. Each takes a second or so, on its own
 * line from the videos, so a photo never waits behind a long video encode
 */
export const COMPRESS_IMAGE_MAX_JOBS = 2
/**
 * Videos compressed at the same time. Each encode already uses every CPU
 * core, so more only makes each one slower.
 */
export const COMPRESS_MAX_JOBS = 1
/**
 * How long after a compression the dialog's Cancel may still delete the copy
 * it saved. Long enough for any batch; short enough that this can't be used
 * to delete the gallery's other files.
 */
export const COMPRESS_DISCARD_WINDOW_MS = 24 * 60 * 60 * 1000
