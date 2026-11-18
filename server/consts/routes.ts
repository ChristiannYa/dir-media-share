// URL paths the backend answers. Keep them in sync with `API` in the Vue
// app's src/constants.ts.

/** Folder listing: GET ?path= */
export const ROUTE_BROWSE = '/api/browse'
/** Name of the shared folder */
export const ROUTE_INFO = '/api/info'
/** Still frame of a video: GET ?path= */
export const ROUTE_THUMB = '/api/thumb'
/** Builds a preview clip, then answers its URL under ROUTE_PREVIEWS as JSON: GET ?path= */
export const ROUTE_PREVIEW = '/api/preview'
/** Builds a folder's preview clip, then answers its URL under ROUTE_PREVIEWS as JSON: GET ?path= */
export const ROUTE_FOLDER_PREVIEW = '/api/folder-preview'
/**
 * Still of a folder's preview (its first video / image), right away, even
 * while the clip is still being built; the same `pick` as ROUTE_FOLDER_PREVIEW: GET ?path=&pick=
 */
export const ROUTE_FOLDER_THUMB = '/api/folder-thumb'
/** Live stream (Server-Sent Events) of preview builds: queued / encoding / done / failed */
export const ROUTE_JOB_EVENTS = '/api/jobs/events'
/** Stops a preview's build (queued or encoding) whose card left the screen: POST ?kind=video|folder&path= */
export const ROUTE_CANCEL_JOB = '/api/jobs/cancel'
/** Builds a storyboard, then returns its URL and layout as JSON: GET ?path= */
export const ROUTE_STORYBOARD = '/api/storyboard'
/**
 * Deletes the cached stills, previews and storyboards of every video in a
 * folder and its subfolders, so they get rebuilt: POST ?path= ; or the whole
 * cache: POST ?all=1. Every device gets fresh copies (server/cacheVersion.ts)
 */
export const ROUTE_CLEAR_CACHE = '/api/cache/clear'
/** Just the subfolders of a folder (fast; used by the "Move to…" picker): GET ?path= */
export const ROUTE_FOLDERS = '/api/folders'
/** Moves a file to the desktop's trash (restorable from the file manager): POST ?path= */
export const ROUTE_TRASH_FILE = '/api/file/trash'
/** Moves a file into another folder of the shared folder: POST ?path=&to= */
export const ROUTE_MOVE_FILE = '/api/file/move'
/**
 * Saves the request body (the raw file, not a form) into a folder of the
 * shared folder; a taken name gets " (2)", " (3)"…: POST ?dir=&name=
 */
export const ROUTE_UPLOAD_FILE = '/api/file/upload'
/**
 * Deletes a file that an upload saved in the last day (the upload dialog's
 * Cancel, which throws the whole batch away); any other file is refused: POST ?path=
 */
export const ROUTE_DISCARD_UPLOAD = '/api/file/discard'
/**
 * The compress queue (server/compressQueue.ts), which saves compressed copies
 * of videos and photos next to them in the background. Its changes are on the
 * job events stream (`event: compress`). Every job, oldest first: GET
 */
export const ROUTE_COMPRESS_JOBS = '/api/compress/jobs'
/** Adds files to the compress queue: POST JSON { files: [{ path, duration? }] } */
export const ROUTE_COMPRESS_QUEUE = '/api/compress/queue'
/** Stops compress jobs, waiting or running: POST ?id= | ?folder= | ?all=1 */
export const ROUTE_COMPRESS_CANCEL = '/api/compress/cancel'
/** Deletes the copy a compress job saved in the last day: POST ?id= */
export const ROUTE_COMPRESS_DISCARD = '/api/compress/discard'
/** Removes the ended compress jobs (of a folder) from the list: POST ?folder= (none: all) */
export const ROUTE_COMPRESS_CLEAR = '/api/compress/clear'
/** A compressed copy was opened: no more "Compressed!" banner (server/compressedNew.ts): POST ?path= */
export const ROUTE_COMPRESS_SEEN = '/api/compress/seen'
/**
 * Remuxes an MPEG-TS video saved as .mp4 into a playable "<name>_ts_fix.mp4"
 * next to it. Answers JSON lines (progress…, done { path, name } / error): POST ?path=
 */
export const ROUTE_FIX_TS = '/api/file/fix-ts'
/**
 * Saves a trimmed / cropped copy of a video as "<name>_edited.mp4" next to it
 * (server/media/edit.ts). Answers JSON lines (progress…, done { path, name } /
 * error); closing the request stops it: POST ?path=&start=&end=&x=&y=&w=&h=
 */
export const ROUTE_EDIT_FILE = '/api/file/edit'
/** Adds or removes the heart of a video or photo (server/favorites.ts): POST ?path=&on=1|0 */
export const ROUTE_FAVORITE = '/api/favorite'
/**
 * The most played videos and photos inside a folder (subfolders included), or
 * (kind=folders) its most played subfolders by their plays added up, most
 * played first, as listing entries (server/plays.ts): GET ?path=&limit=&kind=media|folders
 */
export const ROUTE_MOST_PLAYED = '/api/most-played'
/**
 * The hearted videos and photos inside a folder (subfolders included), in
 * random order, as listing entries (server/favorites.ts): GET ?path=&limit=
 */
export const ROUTE_HEARTED = '/api/hearted'
/** Sets how many times a video / photo was viewed (the edit dialog): POST ?path=&count= */
export const ROUTE_SET_PLAYS = '/api/plays'
/** A video was played / photo shown in the viewer: it and its folders get "last viewed" = now (server/views.ts), and its play count goes up: POST ?path= */
export const ROUTE_VIEWED = '/api/viewed'
/**
 * A video's "most watched parts" (server/heatmap.ts). GET ?path= : `{ counts }`,
 * how many times each part was watched (null if never). POST ?path= with a
 * JSON array body: adds how many times each part was just watched
 */
export const ROUTE_HEATMAP = '/api/heatmap'
/** Creates an empty subfolder `name` inside `dir`: POST ?dir=&name= */
export const ROUTE_CREATE_FOLDER = '/api/folder/create'
/**
 * Renames the photos and videos directly in a folder to <folder>_1, _2… by
 * age, oldest first (their previews to vid_<folder>_<n>): POST ?path=
 */
export const ROUTE_NUMBER_FILES = '/api/folder/number'
/** Renames a file or folder in place; refuses a taken name: POST ?path=&name= */
export const ROUTE_RENAME = '/api/rename'
/**
 * Server settings (server/settings.ts). GET: values, defaults and field
 * descriptions; POST: JSON body of changed values, all applied or none
 */
export const ROUTE_SETTINGS = '/api/settings'
/**
 * App settings shared by every device (server/sharedSettings.ts). GET: the
 * saved values; POST: JSON body of every shared value that differs from the
 * app's defaults, replacing the saved ones
 */
export const ROUTE_SHARED_SETTINGS = '/api/shared-settings'
/** Stops vite and this server */
export const ROUTE_SHUTDOWN = '/api/shutdown'
/** Checks the passcode and sets the session cookie: POST JSON { passcode } */
export const ROUTE_LOGIN = '/api/login'
/** Clears this browser's session cookie, so the lock screen asks again: POST */
export const ROUTE_LOGOUT = '/api/logout'
/** Whether this browser is logged in */
export const ROUTE_SESSION = '/api/session'
/**
 * The image beside the app mode pill: GET ?mode= the whole image, in whatever
 * format it was saved; POST ?mode=&ext= with the file as the body replaces it
 */
export const ROUTE_APP_MODE_IMAGE = '/api/app-mode-image'
/** Each mode's image version and frame (the part the pill shows): GET */
export const ROUTE_APP_MODE_IMAGES = '/api/app-mode-images'
/** Saves the part of a mode's image the pill shows: POST ?mode= JSON { x, y, w, h } */
export const ROUTE_APP_MODE_FRAME = '/api/app-mode-frame'
/** Moves a mode's image to the history; it has none after: POST ?mode= */
export const ROUTE_APP_MODE_IMAGE_REMOVE = '/api/app-mode-image-remove'
/** Makes an image of the history a mode's image again: POST ?mode=&id= */
export const ROUTE_APP_MODE_IMAGE_RESTORE = '/api/app-mode-image-restore'
/** The images replaced or removed, newest first: GET */
export const ROUTE_APP_MODE_HISTORY = '/api/app-mode-history'
/** One image of the history, whole: GET ?id= */
export const ROUTE_APP_MODE_HISTORY_IMAGE = '/api/app-mode-history-image'
/** Deletes an image of the history for good: POST ?id= */
export const ROUTE_APP_MODE_HISTORY_DELETE = '/api/app-mode-history-delete'

// ── Static folders ──

/** Original files of the shared folder (supports Range requests for seeking) */
export const ROUTE_FILES = '/files'
/** Cached preview clips (served from PREVIEW_DIR) */
export const ROUTE_PREVIEWS = '/previews'
/** Cached storyboard images (served from STORYBOARD_DIR) */
export const ROUTE_STORYBOARDS = '/storyboards'
