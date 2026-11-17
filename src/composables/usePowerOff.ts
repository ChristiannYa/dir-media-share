import { nextTick, ref } from 'vue'

/** The screen went black (shutdown): Root.vue covers everything */
export const poweredOff = ref(false)

/**
 * Turns the screen off like an old TV: the picture collapses into a bright
 * line through the middle, then into a dot, leaving a black screen.
 *
 * A view transition (like useLock's showLockScreen) so the whole screen,
 * fixed parts included, shrinks around the middle of the viewport. Without
 * view transitions, or with reduced motion, the screen just goes black.
 */
export async function playPowerOff(): Promise<void> {
  const swap = async () => {
    poweredOff.value = true
    await nextTick()
  }
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!('startViewTransition' in document) || reduceMotion) {
    await swap()
    return
  }
  // the animation's CSS (Root.vue) applies only while this class is on
  const root = document.documentElement
  root.classList.add('powering-off')
  try {
    await document.startViewTransition(swap).finished
  } catch {
    // skipped (e.g. the tab was hidden): the screen is black anyway
  } finally {
    root.classList.remove('powering-off')
  }
}
