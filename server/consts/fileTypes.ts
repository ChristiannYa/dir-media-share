// Which files are treated as images and videos.

/** Extensions (lowercase) listed as images */
export const IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic']
/** Extensions (lowercase) listed as videos: they get a duration, a still, a preview and a storyboard */
export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mp3', 'mov', 'mkv', 'webm']
/** ffprobe container name of MPEG-TS (browsers can't play it); such files get the "TS" badge */
export const MPEGTS_FORMAT = 'mpegts'
