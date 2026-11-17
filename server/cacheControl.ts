// Cache-Control headers for generated files, from the "Browser cache" setting
// (cacheMaxAgeDays). Built per response, so a change applies right away.

import { serverSettings } from './settings.ts'

function maxAgeSecs(): number {
  return Math.round(serverSettings.cacheMaxAgeDays * 24 * 60 * 60)
}

/**
 * Previews and storyboards. Their URLs change whenever they're rebuilt (the
 * `?v=` part), so a cached copy is never outdated: the browser may reuse it
 * for the whole time without checking ("immutable"), and a preview that
 * scrolls back into view or reappears after closing the player plays
 * straight from the browser's cache.
 */
export function generatedCacheControl(): string {
  const secs = maxAgeSecs()
  return secs > 0 ? `public, max-age=${secs}, immutable` : 'no-cache'
}

/**
 * Stills. Their URL doesn't change when a video is edited, so an edited video
 * can show its old still for up to this long; "Clear cache" in a folder's
 * menu changes the URLs and forces fresh copies.
 */
export function thumbCacheControl(): string {
  const secs = maxAgeSecs()
  return secs > 0 ? `max-age=${secs}` : 'no-cache'
}
