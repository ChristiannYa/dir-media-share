// Reading video metadata with ffprobe.

/** Frame rates above this are treated as unknown: broken timestamps (often from MPEG-TS) can make ffprobe report values like 90000 fps */
export const MAX_PLAUSIBLE_FPS = 240.0
/** Folder listings probe their videos in parallel; at most this many ffprobe runs at once (default; see Settings) */
export const PROBE_MAX_JOBS = 8
