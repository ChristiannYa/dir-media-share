// Auto-playing clip on each folder card.
//
// Only for folders that hold media themselves (the last folder above the
// files); a folder that only contains other folders gets no preview. Built
// from the files directly inside: slices of its videos (PREVIEW_SECS long),
// going round them, or, if there are no videos,
// a slideshow of its images, each on screen as long as a slice plays. Uses
// the settings in previews.ts and shares PREVIEW_MAX_JOBS.

/** (Default; see Settings / server/settings.ts.) Max number of slices (or images) used; a random pick of the folder's files, so big folders still give a short loop */
export const FOLDER_PREVIEW_ITEMS = 10
/**
 * (Default; see Settings / server/settings.ts.) Most slices taken from one
 * video. A folder with few videos goes round them (v1, v2, v1, v2…) until each
 * gave this many or the preview has FOLDER_PREVIEW_ITEMS slices
 */
export const FOLDER_PREVIEW_SLICES_PER_VIDEO = 3
/**
 * (Default; see Settings / server/settings.ts.) How many different random
 * previews each folder can have. Each time a folder card appears it shows one
 * of them at random; each is encoded the first time it's shown, then kept.
 * More means more variety, but more encoding and disk space per folder.
 */
export const FOLDER_PREVIEW_VARIANTS = 6
/** Image types used for the slideshow (ones ffmpeg reads reliably; GIF and HEIC are left out) */
export const FOLDER_PREVIEW_IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp']
