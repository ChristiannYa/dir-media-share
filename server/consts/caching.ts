// Where generated stills, previews and storyboards are kept, how big that
// may grow, and how long the browser keeps them. The Cache-Control headers
// are built in server/cacheControl.ts and the size limit is enforced by
// server/cachePrune.ts, both from the current settings.

import os from 'node:os'
import path from 'node:path'

/** Environment variable naming the cache folder, to override the default below */
export const CACHE_DIR_ENV = 'MED_CACHE_DIR'

/**
 * The cache folder: MED_CACHE_DIR if set, otherwise $XDG_CACHE_HOME/med,
 * usually ~/.cache/med. On disk, not in /tmp: on many systems (CachyOS, Arch,
 * Fedora…) /tmp lives in RAM and is capped at half of it, which the previews
 * of a big folder fill up ("No space left on device"), and it's emptied on
 * every reboot, so everything would be encoded again.
 */
export const CACHE_ROOT =
  process.env[CACHE_DIR_ENV] ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'med')

/**
 * Where older versions kept the cache (in /tmp). Emptied once at startup
 * (server/cachePrune.ts) to give the RAM back; they only ever held files this
 * app can build again.
 */
export const LEGACY_CACHE_DIRS = ['/tmp/med-thumbs', '/tmp/med-previews', '/tmp/med-storyboards']

/**
 * (Default; see Settings / server/settings.ts.) Most disk space the cache may
 * use, in GB. Above it, the files used longest ago are deleted (they're
 * rebuilt if needed again). Files made with old settings are never used again,
 * so without a limit the cache only ever grows.
 */
export const CACHE_MAX_GB = 20

/** How often the cache size is checked (ms) */
export const CACHE_PRUNE_INTERVAL_MS = 60 * 1000

/** Files used this recently are never deleted: a page may still be showing them (ms) */
export const CACHE_KEEP_RECENT_MS = 10 * 60 * 1000

/**
 * When over the limit, delete down to this share of it, so the next few new
 * files don't start deleting again right away
 */
export const CACHE_PRUNE_TARGET = 0.9

/**
 * (Default; see Settings / server/settings.ts.) Days the browser may reuse a
 * still, preview or storyboard without asking the server again. 0 = it asks
 * every time (unchanged previews and storyboards aren't sent again; stills are).
 */
export const CACHE_MAX_AGE_DAYS = 7
