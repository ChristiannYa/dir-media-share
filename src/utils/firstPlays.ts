/**
 * Previews that already played since the page loaded ("kind:path"), so the
 * welcome for a new one (a haptic buzz, the card's pulse) happens once, not
 * again when it's scrolled back to or its folder is opened again
 */
const played = new Set<string>()

/** True the first time `key` plays since the page loaded */
export function isFirstPlay(key: string): boolean {
  if (played.has(key)) return false
  played.add(key)
  return true
}
