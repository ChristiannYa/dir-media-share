// Settings shared by every resized image and clip ffmpeg makes.

/**
 * ffmpeg scaling algorithm for stills and previews. "lanczos" keeps more
 * detail when shrinking than ffmpeg's default ("bicubic"). Part of their
 * cache names, so changing it rebuilds them. Default: the app's Settings
 * popup can override it (server/settings.ts).
 */
export const SCALE_FLAGS = 'lanczos'
