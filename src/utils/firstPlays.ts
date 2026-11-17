/**
 * Previews that already played since the page loaded ("kind:path"), so the
 * welcome for a new one happens once, not again when it's scrolled back to or
 * its folder is opened again: its haptic buzz (PreviewVideo.vue), and its
 * blurred start and reveal (a card made for one that already played shows it
 * sharp: GalleryCard.vue)
 */
const played = new Set<string>()

/** True if `key` already played since the page loaded (only looks: doesn't count as playing) */
export function hasPlayed(key: string): boolean {
  return played.has(key)
}

/** True the first time `key` plays since the page loaded */
export function isFirstPlay(key: string): boolean {
  if (played.has(key)) return false
  played.add(key)
  return true
}
