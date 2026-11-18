// Editing videos and photos: the trimmed / cropped copies the edit dialog
// asks for, made in the background by the compress queue
// (server/compressQueue.ts, server/media/editMedia.ts).
//
// Like the compression's (./compress.ts), these are fixed, not in the app's
// Settings: an edit should look like the original, so they're picked for a
// copy that's hard to tell from it. To change one, edit it here and restart
// the server. The encodes run on a share of the CPU at the lowest priority,
// like the compressions (COMPRESS_CPU_SHARE, COMPRESS_NICE).

/** Added to the name of the edited copy: "clip.mov" → "clip_edited.mp4" */
export const EDITED_SUFFIX = '_edited'
/**
 * x264 quality (CRF) of edited 8-bit videos: lower is better and bigger. 18
 * looks near-lossless: the copy is cut, not meant to be smaller
 */
export const EDIT_CRF = 18
/** x264 speed/size trade-off; slower makes smaller files at the same quality */
export const EDIT_PRESET = 'slow'
/**
 * x265 quality (CRF) of edited 10-bit / HDR videos (kept 10-bit, in HEVC):
 * 20 in x265 looks about like 18 in x264
 */
export const EDIT_HEVC_CRF = 20
/**
 * x265's speed/size trade-off. x265 is several times slower than x264, and
 * these are mostly 4K phone videos: medium keeps an edit within minutes
 */
export const EDIT_HEVC_PRESET = 'medium'
/** Bitrate of the edited copy's AAC audio (cut on the exact frame, so encoded again) */
export const EDIT_AUDIO_BITRATE = '256k'
/**
 * WebP quality (cwebp, 0–100) of a cropped lossy WebP, encoded again: high
 * enough not to see. Lossless WebPs stay lossless, PNGs too; JPEGs are cropped
 * without encoding them again at all (server/media/cropJpeg.ts)
 */
export const EDIT_WEBP_QUALITY = 90
