import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * The animated night sky pauses while something covers it: a dialog (its
 * backdrop blurs the whole screen, so every frame of the sky behind it would
 * be blurred again: that alone kept a laptop GPU near 100% during uploads) or
 * the video player.
 */

/** How many things currently cover the background */
const holders = ref(0)

/** True while the background should stand still */
export const backgroundPaused = computed(() => holders.value > 0)

/** Pauses the background until the returned function is called */
export function holdBackgroundPause(): () => void {
  holders.value++
  let released = false
  return () => {
    if (released) return
    released = true
    holders.value--
  }
}

/** Pauses the background for as long as the calling component is on screen */
export function usePauseBackgroundWhileMounted() {
  let release: (() => void) | null = null
  onMounted(() => (release = holdBackgroundPause()))
  onUnmounted(() => release?.())
}
