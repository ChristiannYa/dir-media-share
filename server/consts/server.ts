// How the server starts and who may use it.

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Port the standalone server (server/main.ts) listens on, on all interfaces so phones on the LAN can connect */
export const PORT = 2002
/**
 * Environment variable holding the lock screen's passcode (digits only);
 * every request is refused without it
 */
export const PASSWORD_ENV = 'MED_PASSWORD'
/**
 * Environment variable naming the folder to share. Without it, the folder the
 * command was started from is shared (also when started through npm).
 */
export const SHARE_ROOT_ENV = 'MED_ROOT'
/** Cookie holding the login after the right passcode was entered */
export const SESSION_COOKIE = 'med_session'
/**
 * Cookie holding the device's app mode, set by the app (src/appMode.ts):
 * "dev" = nothing of the video data is recorded or sent (server/appMode.ts)
 */
export const APP_MODE_COOKIE = 'med_mode'
/** How long a device stays logged in when "Lock after" is 0 (seconds): 30 days */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
/**
 * Default of Settings → Server → Lock screen → Lock after: minutes from
 * unlocking until the app locks itself and asks for the passcode again (0 = never)
 */
export const LOCK_AFTER_MINUTES = 30
/** Wrong passcodes in a row before the lock screen makes you wait */
export const LOGIN_MAX_FAILS = 5
/** First wait after LOGIN_MAX_FAILS; doubles with each further miss, up to LOGIN_MAX_LOCKOUT_MS */
export const LOGIN_LOCKOUT_MS = 60_000
export const LOGIN_MAX_LOCKOUT_MS = 24 * 60 * 60_000
/**
 * Where the Settings popup saves the server settings (server/settings.ts):
 * config/server-settings.json in this project. Only values that differ from
 * the defaults in server/consts/ are stored; delete the file to go back to all
 * defaults. (Found from this file's own location, so it's the same wherever
 * the server is started from.)
 */
export const SETTINGS_FILE = fileURLToPath(
  new URL('../../config/server-settings.json', import.meta.url),
)
/**
 * Where the Settings popup saves the app settings shared by every device
 * (sort, video player, look, background…; server/sharedSettings.ts):
 * config/shared-settings.json in this project. Only values that differ from
 * the app's defaults are stored; delete the file to go back to all defaults.
 */
export const SHARED_SETTINGS_FILE = fileURLToPath(
  new URL('../../config/shared-settings.json', import.meta.url),
)
/**
 * What the app records about the media (hearts, views, plays, heatmaps):
 * config/data/ in this project. Personal data, not settings: kept out of git
 * (.gitignore). Each file is created on its first save; a missing one starts
 * empty.
 */
export const DATA_DIR = fileURLToPath(new URL('../../config/data/', import.meta.url))
/**
 * The videos and photos marked with the heart (server/favorites.ts): a list of
 * paths inside the shared folder. Shared by every device.
 */
export const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json')
/**
 * When each video, and each folder holding it, was last played in the viewer
 * (server/views.ts): path → ms since 1970. Shared by every device.
 */
export const VIEWS_FILE = path.join(DATA_DIR, 'views.json')
/**
 * How many times each video was played in the viewer, or each photo shown
 * there (server/plays.ts): path → count. Shared by every device; the folders'
 * "Most played" sections come from it.
 */
export const PLAYS_FILE = path.join(DATA_DIR, 'plays.json')
/**
 * The cache version shared by every device (server/cacheVersion.ts): a
 * number that goes up each time a cache is cleared
 */
export const CACHE_VERSION_FILE = path.join(DATA_DIR, 'cache-version.json')
/**
 * How many times each part of each video was watched (server/heatmap.ts), for
 * the "most watched parts" over the player's slider: path → counts. Shared by
 * every device.
 */
export const HEATMAP_FILE = path.join(DATA_DIR, 'heatmap.json')
/**
 * The images beside the app mode pill (src/components/AppModeButton.vue): one
 * per mode, named after it in any image format (goon.png, dev.jpg…), and
 * frames.json with the part of each the pill shows; the ones replaced or
 * removed in history/ (listed in history.json). Changed from the popup a tap
 * on the image opens; served by server/handlers/appModeImage.ts.
 */
export const APP_MODE_IMAGES_DIR = path.join(DATA_DIR, 'app-mode')
/**
 * Where older versions saved them ($XDG_CONFIG_HOME/med/, usually
 * ~/.config/med/). Read only while SETTINGS_FILE doesn't exist yet, so saved
 * settings carry over; the next save writes SETTINGS_FILE.
 */
export const LEGACY_SETTINGS_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'med',
  'server-settings.json',
)
/** Built frontend (`npm run build` output), relative to the project root */
export const DIST_DIR = 'dist'
