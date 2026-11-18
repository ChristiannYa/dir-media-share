// The values from here down to "Server endpoints" are defaults: they can be
// changed in the app's Settings (src/settings.ts). Code should read them from
// `settings`, not from here, so changes apply.

// ── Loading indicator ──

/** Number of colored dots running around a card's border while it loads */
export const LOADING_DOTS = 1

// ── Grid ──

/**
 * Columns of cards. With a number, the top bar and the grid sit in a centered
 * column just wide enough for that many cards (each up to GRID_COLUMN_WIDTH),
 * like a phone screen in the middle of a laptop's. 0 = as many as fit the window
 */
export const GRID_COLUMNS = 2
/** Widest a card gets when the columns are fixed (px) */
export const GRID_COLUMN_WIDTH = 300

// ── Previews ──

/**
 * How far outside the screen a card counts as on screen (CSS margin syntax):
 * within this its preview plays, further out it's paused.
 */
export const PREVIEW_ROOT_MARGIN = '150px'
/**
 * How far from the screen a card keeps its loaded preview (paused) instead of
 * dropping it. Previews only start loading within PREVIEW_ROOT_MARGIN. Percentages are of the screen height: '300% 0px' keeps about 3
 * screens above and below, so scrolling back is instant. Further away the
 * preview is dropped to free memory and reloads (from the browser's cache)
 * when you come back. Bigger keeps more, but uses more memory on the phone.
 */
export const PREVIEW_KEEP_MARGIN = '300% 0px'
/**
 * Show a small pill on each preview saying what its load is doing (asking the
 * server, queued, encoding, downloading, from cache…). Set to false to hide it.
 */
export const SHOW_PREVIEW_STATUS = true
/**
 * Speed previews play at (1.3 = 30% faster). Applied by the browser as a
 * playback rate, so changing it is instant: the server encodes at 1×.
 */
export const PREVIEW_SPEED = 1.3
/**
 * Adjust each preview's speed to the nearest one that moves evenly on this
 * screen (src/utils/smoothSpeed.ts), e.g. 1.3× → 1.33× on a 120 Hz screen
 */
export const SMOOTH_PREVIEWS = true
/** The most smoothing may move the speed away from PREVIEW_SPEED (in ×) */
export const SMOOTH_MAX_CHANGE = 0.35
/**
 * While a preview is being built, the card waits for the server's "done"
 * event; if none comes within this long it asks the server again (in case
 * the event stream dropped it)
 */
export const PREVIEW_RECHECK_MS = 20000
/**
 * Most previews playing at the same time: the ones nearest the middle of the
 * screen play, the others show their still. Each playing preview is decoded
 * and redrawn 30 times a second, so this is what the GPU load of a folder
 * comes down to. 0 = every one on screen plays
 */
export const MAX_PLAYING_PREVIEWS = 6
/** Once a preview plays, its pill shows where the clip came from for this long, then fades */
export const PREVIEW_STATUS_LINGER_MS = 2500

// ── Sorting ──

/**
 * What the files of a folder are sorted by (biggest first); folders always
 * come first, by name. "quality": most pixels first, then the higher frame
 * rate. "favorites": the hearted ones first, each part by duration
 */
export const SORT_OPTIONS = ['duration', 'size', 'quality', 'date added', 'favorites'] as const
export type SortBy = (typeof SORT_OPTIONS)[number]
/** Default order: longest videos first */
export const SORT_BY: SortBy = 'duration'

// ── Haptics ──

/**
 * Vibrate a little on taps (folders, files, play / pause, next media, Done,
 * lock screen keys), skips and previews playing for the first time (utils/haptics.ts)
 */
export const HAPTICS = true
/**
 * How long a tap's vibration lasts (ms); the others scale from it. Browsers
 * can't set a vibration's strength, only its length, and longer feels
 * stronger. How strong the motor runs is the phone's own setting
 */
export const HAPTIC_MS = 40

// ── Video player ──

/** Start a video over from the beginning once it ends, instead of stopping */
export const LOOP_VIDEOS = false
/** Seconds skipped by double-tapping the left/right side of the video (also the arrow keys) */
export const SEEK_STEP_SECONDS = 10
/**
 * Max time between two taps for them to count as a double tap. A single tap
 * on a side waits this long before toggling the controls.
 */
export const DOUBLE_TAP_MS = 300
/** Controls fade out after this long without any interaction */
export const CONTROLS_HIDE_DELAY_MS = 3000
/** Fraction of the video's width, on each side, that seeks when double-tapped */
export const SEEK_TAP_ZONE = 0.3
/** How long the "+10s" bubble stays on screen */
export const SEEK_FEEDBACK_MS = 600
/** Holding a side of the video this long starts continuous seeking (shorter is a tap) */
export const HOLD_SEEK_DELAY_MS = 350
/** Seeking speed when the hold starts: seconds of video per second (2 = twice real time) */
export const HOLD_SEEK_SPEED = 2
/**
 * Speed added per 100px the finger slides away from where it pressed (any
 * direction), in steps of 0.1×: with 4, sliding 50px goes from 2× to 4×
 */
export const HOLD_SEEK_GAIN = 4
/** Fastest hold-seek speed. Forward up to 16× plays smoothly; above that it jumps between frames */
export const HOLD_SEEK_MAX_SPEED = 16
/** Width (px) of the frame preview shown above the slider */
export const SCRUB_PREVIEW_WIDTH = 160

// ── Server endpoints ──

/**
 * Server API paths. Keep in sync with the ROUTE_* constants in
 * server/consts/routes.ts.
 */
export const API = {
  /** Name of the shared folder */
  info: '/api/info',
  /** Folder listing: ?path= */
  browse: '/api/browse',
  /** Still frame of a video: ?path= */
  thumb: '/api/thumb',
  /** Builds a video's preview clip and answers `{ url, built }`: ?path= */
  preview: '/api/preview',
  /** Same for a folder's preview, made from the videos (or images) inside: ?path= */
  folderPreview: '/api/folder-preview',
  /** Still of a folder's preview (its first video / image), right away: ?path=&pick= (the same pick) */
  folderThumb: '/api/folder-thumb',
  /** Live stream of preview builds (queued / encoding / done / failed) */
  jobEvents: '/api/jobs/events',
  /** Stops a preview's build whose card left the screen (POST): ?kind=video|folder&path= */
  cancelJob: '/api/jobs/cancel',
  /** Frame grid for the player's slider preview: ?path= */
  storyboard: '/api/storyboard',
  /** Deletes the cached stills/previews/storyboards of a folder (POST): ?path= */
  clearCache: '/api/cache/clear',
  /** Subfolders of a folder, for the "Move to…" picker: ?path= */
  folders: '/api/folders',
  /** Moves a file to the computer's trash, restorable from the file manager (POST): ?path= */
  trashFile: '/api/file/trash',
  /** Moves a file into another folder (POST): ?path=&to= */
  moveFile: '/api/file/move',
  /** Saves the request body as a new file in a folder (POST): ?dir=&name= */
  uploadFile: '/api/file/upload',
  /** Creates an empty subfolder (POST): ?dir=&name= */
  createFolder: '/api/folder/create',
  /** Renames a file or folder in place (POST): ?path=&name= */
  rename: '/api/rename',
  /** Renames a folder's photos and videos to <folder>_1, _2… oldest first (POST): ?path= */
  numberFiles: '/api/folder/number',
  /** Server settings. GET: values, defaults, fields; POST: JSON of changed values */
  settings: '/api/settings',
  /** Deletes a file that was just uploaded (upload dialog's Cancel): POST ?path= */
  discardUpload: '/api/file/discard',
  /**
   * Saves a compressed copy of a video next to it (POST): ?path=. Answers
   * JSON lines: queued, started, progress…, done / error
   */
  compressFile: '/api/file/compress',
  /** Deletes a just-compressed copy (compress dialog's Cancel): POST ?path= */
  discardCompressed: '/api/file/compress/discard',
  /** Saves a playable "<name>_ts_fix.mp4" copy of an MPEG-TS video (POST): ?path=. Answers { path, name } */
  fixTs: '/api/file/fix-ts',
  /**
   * Saves a trimmed / cropped "<name>_edited.mp4" copy of a video (POST):
   * ?path=&start=&end=&x=&y=&w=&h=. Answers JSON lines: progress…, done / error
   */
  editFile: '/api/file/edit',
  /** The most played videos and photos inside a folder (subfolders included): ?path=&limit= */
  mostPlayed: '/api/most-played',
  /** Hearted videos and photos inside a folder (subfolders included), shuffled: ?path=&limit= */
  hearted: '/api/hearted',
  /** Sets how many times a video / photo was viewed (POST): ?path=&count= */
  setPlays: '/api/plays',
  /** A video was played in the viewer: it and its folders get "last viewed" = now, and one more play (POST): ?path= */
  viewed: '/api/viewed',
  /** Adds or removes the heart of a video or photo: POST ?path=&on=1|0 */
  favorite: '/api/favorite',
  /**
   * A video's "most watched parts". GET ?path= : `{ counts }`; POST ?path= with
   * a JSON array body: adds how many times each part was just watched
   */
  heatmap: '/api/heatmap',
  /** App settings shared by every device: GET the saved ones, POST all changed ones */
  sharedSettings: '/api/shared-settings',
  /** Stops the server */
  shutdown: '/api/shutdown',
  /** Checks the passcode, sets the login cookie: POST JSON { passcode } */
  login: '/api/login',
  /** Clears this browser's login cookie (POST) */
  logout: '/api/logout',
  /** Logged in? */
  session: '/api/session',
  /**
   * The image beside the app mode pill (config/data/app-mode/, any image
   * format): GET ?mode= the whole image; POST ?mode=&ext= with the file replaces it
   */
  appModeImage: '/api/app-mode-image',
  /** Each mode's image version and frame (the part the pill shows): GET */
  appModeImages: '/api/app-mode-images',
  /** Saves the part of a mode's image the pill shows: POST ?mode= JSON { x, y, w, h } */
  appModeFrame: '/api/app-mode-frame',
  /** Moves a mode's image to the history; it has none after: POST ?mode= */
  appModeImageRemove: '/api/app-mode-image-remove',
  /** Makes an image of the history a mode's image again: POST ?mode=&id= */
  appModeImageRestore: '/api/app-mode-image-restore',
  /** The images replaced or removed, newest first: GET */
  appModeHistory: '/api/app-mode-history',
  /** One image of the history, whole: GET ?id= */
  appModeHistoryImage: '/api/app-mode-history-image',
  /** Deletes an image of the history for good: POST ?id= */
  appModeHistoryDelete: '/api/app-mode-history-delete',
} as const

/**
 * How many equal parts a video is cut into for its "most watched parts" over
 * the slider. Keep in sync with HEATMAP_BINS in server/consts/heatmap.ts
 */
export const HEATMAP_BINS = 100
/** Most a part may go up by in one report (the server refuses more); HEATMAP_MAX_ADD there */
export const HEATMAP_MAX_ADD = 50
/** While a video plays, what was watched is sent this often (and when it's closed) */
export const HEATMAP_FLUSH_MS = 30_000

/** Original files are served under this prefix (path segments are URL-encoded after it) */
export const FILES_PREFIX = '/files/'

/**
 * localStorage key of the cache version. It goes up each time a folder's cache
 * is cleared and is added to still-image URLs, so the browser drops its own
 * copies too (it keeps stills for an hour otherwise).
 */
export const CACHE_VERSION_STORAGE_KEY = 'med.cacheVersion'
/**
 * sessionStorage key of where the app was when it locked (composables/useResume.ts),
 * so unlocking returns there, also after a reload of the tab
 */
export const RESUME_STORAGE_KEY = 'med.resume'
/** localStorage key of this device's own settings changed in the Settings popup (src/settings.ts) */
export const SETTINGS_STORAGE_KEY = 'med.settings'
/** localStorage key of this browser's copy of the settings shared by every device (src/settings.ts) */
export const SHARED_SETTINGS_STORAGE_KEY = 'med.sharedSettings'

// ── Folder menu ──

/** How long the result of a menu action ("Removed 12 files") stays before the menu closes (default; see Settings) */
export const MENU_STATUS_MS = 1500

/**
 * How long a card flashes when the app leads you to it (App.vue revealCard:
 * a "Most played" card opened, a folder just created), ms. The card's bounce
 * (App.vue) and its spinning glow (GalleryCard.vue) both last this long
 */
export const REVEAL_MS = 3800

// ── Settings popup ──

/**
 * How many of the most changed settings the "Frequently changed" section at
 * the top of every Settings tab lists (default; see Settings → Menus). 0 = none
 */
export const FREQUENT_SETTINGS_MAX = 5
/** localStorage key of how many times each setting was changed (with Done), for that section */
export const SETTING_USES_STORAGE_KEY = 'med.settingUses'
/** localStorage key of this device's app mode, dev or goon (src/appMode.ts) */
export const APP_MODE_STORAGE_KEY = 'med.appMode'
/** Cookie telling the server this device's app mode (keep equal to APP_MODE_COOKIE in server/consts/server.ts) */
export const APP_MODE_COOKIE = 'med_mode'

// ── Night sky ──
// The stars, shooting stars and satellites behind the gallery (NightSky.vue),
// over drifting nebula clouds (App.vue). The first three are defaults: see
// Settings → Background.

/** How many stars are in the sky (0 = none) */
export const SKY_STAR_COUNT = 260
/** Seconds between shooting stars, on average (0 = none) */
export const SKY_SHOOTING_STAR_EVERY = 6
/** How fast the stars drift sideways, in px per second (0 = still); far ones go slower */
export const SKY_STAR_DRIFT = 4
/**
 * Most frames per second the sky is drawn at. It moves slowly, so 30 looks
 * the same as a 144 Hz screen's 144 while costing the GPU far less (the
 * frosted glass blurs the sky again on every frame it changes)
 */
export const SKY_MAX_FPS = 30
/** Seconds between satellites slowly crossing the sky, on average (0 = none) */
export const SKY_SATELLITE_EVERY = 45
/** Share of the stars packed into the faint Milky Way band across the sky (0–1) */
export const SKY_MILKY_WAY_SHARE = 0.35
/** Star tints and how common each is: mostly white, some blue, a few warm ones */
export const SKY_STAR_COLORS: ReadonlyArray<{ color: string; weight: number }> = [
  { color: '#ffffff', weight: 6 },
  { color: '#cfe0ff', weight: 3 },
  { color: '#fff1d6', weight: 2 },
  { color: '#ffd2c2', weight: 1 },
]

// ── Text ──

/** Tooltip of the red "TS" badge on videos that are MPEG-TS saved as .mp4 */
export const TS_BADGE_TITLE =
  'MPEG-TS saved as .mp4. Browsers can\'t play it. Right-click or hold the video, then "Fix TS" to save a playable copy.'
/** File menu item on MPEG-TS videos that saves a playable "<name>_ts_fix.mp4" copy */
export const FIX_TS_LABEL = 'Fix TS'
/** Confirmation shown before the shutdown button stops the server */
export const SHUTDOWN_CONFIRM = 'Shut down the server?'
/** Folder menu item that deletes the folder's cached stills, previews and storyboards */
export const CLEAR_CACHE_LABEL = 'Clear cache'
/** Asked before clearing; `{name}` is replaced by the folder name */
export const CLEAR_CACHE_CONFIRM =
  'Delete the cached stills, previews and storyboards of everything in "{name}"? They are rebuilt the next time they are needed, on every device. Your files are not touched.'
/** Asked before the Settings → Server button empties the whole cache */
export const CLEAR_ALL_CACHES_CONFIRM =
  'Delete every cached still, preview and storyboard, of every folder? Every device fetches fresh ones, and they are rebuilt as they are viewed again, which takes a while for big folders. Your files are not touched.'
/** Folder menu item that creates a subfolder inside it */
export const NEW_FOLDER_LABEL = 'New folder'
/** Folder menu item that renames its photos and videos after it, numbered by age */
export const NUMBER_FILES_LABEL = 'Number files by date'
/** Asked before numbering; `{name}` is replaced by the folder name */
export const NUMBER_FILES_CONFIRM =
  'Rename every photo and video in "{name}" after the folder, numbered from the oldest (1) to the newest? Their previews get the same numbers. Subfolders and other files are not touched.'
/** Folder menu item that opens the device's file picker */
export const UPLOAD_LABEL = 'Upload photos or videos'
/**
 * What the file picker offers. Types without a common MIME type are listed by
 * extension. The server only accepts the IMAGE_EXTENSIONS / VIDEO_EXTENSIONS
 * of server/consts/fileTypes.ts.
 */
export const UPLOAD_ACCEPT = 'image/*,video/*,.heic,.mkv,.mp3'
/**
 * How many files upload at the same time. Browsers open at most 6 connections
 * per server over HTTP/1.1, and stills/previews share them, so going higher
 * mostly starves the gallery without making the batch faster.
 */
export const UPLOAD_CONCURRENCY = 3
/** File menu item and selection bar button that save compressed copies of videos and photos */
export const COMPRESS_LABEL = 'Compress'
/**
 * Video extensions the server can compress (server/media/compress.ts); other
 * videos (e.g. .mp3) don't get the option
 */
export const COMPRESSIBLE_EXTENSIONS: readonly string[] = ['mp4', 'm4v', 'mov', 'mkv', 'webm']
/**
 * Photo extensions the server can compress (server/media/compressImage.ts).
 * GIFs would lose their animation, and HEIC has no tool there
 */
export const COMPRESSIBLE_IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp']
/** File menu item that opens the edit dialog (trim a video's ends, crop the edges) */
export const EDIT_LABEL = 'Edit'
/** Added to the name of an edited copy: "photo.jpg" → "photo_edited.jpg" (server/consts/edit.ts) */
export const EDITED_SUFFIX = '_edited'
/** Photo extensions the browser can crop and write back in the same format */
export const EDITABLE_IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp']
/** File and folder menu item that renames it */
export const RENAME_LABEL = 'Rename'
/** File menu item that opens the folder picker */
export const MOVE_LABEL = 'Move to…'
/** File menu item that moves the file to the computer's trash */
export const TRASH_LABEL = 'Move to trash'
/** Asked before trashing; `{name}` is replaced by the file name (shown in the menu popup) */
export const TRASH_CONFIRM =
  'Move "{name}" to the trash? You can restore it from the trash in your file manager.'
/**
 * Folders inside any of these (at any depth) show their name in the theme
 * colors, like the ring around videos. Matched without leading dots and
 * ignoring case, so ".cinema" counts as "cinema". On/off: Settings → Look →
 * Colored folder names
 */
export const THEMED_NAME_PARENTS: readonly string[] = ['cinema', 'know', 'leaks', 'rand']
/**
 * The alphabet bar under the top bar only shows in the folders directly
 * inside these (.bin/cinema: yes; .bin itself and .bin/cinema/augustames: no),
 * when the page scrolls. Matched like THEMED_NAME_PARENTS: without leading
 * dots and ignoring case, so ".bin" counts as "bin"
 */
export const ALPHABET_FOLDERS: readonly string[] = ['bin']
/**
 * The folders inside these, and the folders inside those (.bin/cinema and
 * .bin/cinema/annaralphs: yes; .bin itself and deeper: no) get a "Most
 * played" section above their grid: in .bin/cinema its most played
 * subfolders, in .bin/cinema/annaralphs its most played videos and photos.
 * Matched like ALPHABET_FOLDERS
 */
export const MOST_PLAYED_PARENTS: readonly string[] = ['bin']
/**
 * How many videos / photos the "Most played" section shows (default; see
 * Settings → Most played). 0 = no section
 */
export const MOST_PLAYED_COUNT = 10
/** Title of that section */
export const MOST_PLAYED_TITLE = 'Most viewed'
/** Shown in that section while nothing in the folder was played yet */
export const MOST_PLAYED_EMPTY_TEXT = 'Nothing viewed here...yet'
/**
 * How many hearted videos / photos the "Hearted" section (under "Most
 * played", only where it lists videos and photos: .bin/<x>/<y>) shows (default; see Settings → Most played).
 * 0 = no section
 */
export const HEARTED_COUNT = 6
/** How many hearted ones are fetched at once: the section shows HEARTED_COUNT, the rest get swapped in */
export const HEARTED_POOL = 40
/** Every this many ms, a full "Hearted" section swaps one random card for one it doesn't show */
export const HEARTED_SWAP_MS = 5000
/** Title of that section */
export const HEARTED_TITLE = 'Mos loved'
/** Shown in that section while nothing in the folder is hearted */
export const HEARTED_EMPTY_TEXT = 'No love shown here...yet'
/**
 * Seconds of a video that have to be watched in the viewer (or fullscreen)
 * before it counts as a view and as "last viewed" (default; see Settings →
 * Most played). Skipping and fast seeking don't count. A shorter video counts
 * once 90% of it was watched. 0 = as soon as it starts playing
 */
export const VIEW_AFTER_SECONDS = 10

/**
 * Fonts the app can use (Settings → Look → Font): name shown → CSS font
 * stack. Comic Code is served from public/fonts (styles/fonts.css), Shantell
 * Sans from Google Fonts (index.html). To add a font, put its files in
 * public/fonts, add @font-face rules to styles/fonts.css and an entry here.
 */
export const APP_FONTS: Readonly<Record<string, string>> = {
  'Comic Code': "'Comic Code', 'Shantell Sans', system-ui, sans-serif",
  'Shantell Sans': "'Shantell Sans', system-ui, sans-serif",
  System: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
}
/** Font used unless another is picked; its stack is also --font-body in tokens.css */
export const APP_FONT = 'Comic Code'

/** Shown when the current folder has no entries */
export const EMPTY_FOLDER_TEXT = 'This folder is empty'
