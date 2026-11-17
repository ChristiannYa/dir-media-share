import { onMounted, onUnmounted, ref } from 'vue'

/** Near the top of the page the bar always shows (px scrolled) */
const SHOW_NEAR_TOP = 80
/** How far the page must move one way before the bar hides or comes back (px) */
const TURN_DISTANCE = 8

/**
 * A `hidden` flag for a sticky bar: true after scrolling down, false again
 * as soon as the page scrolls back up (or is near the top). While `canHide()`
 * returns false (e.g. a dialog is open) it stays shown.
 */
export function useScrollHide(canHide: () => boolean = () => true) {
  const hidden = ref(false)
  let lastY = 0
  /** How far the page moved in the current direction: + down, - up */
  let travel = 0
  let frame = 0

  function check() {
    frame = 0
    // iOS bounces past the top: negative values count as the top
    const y = Math.max(0, window.scrollY)
    const dy = y - lastY
    lastY = y
    if (dy === 0) return
    // keep adding up while going the same way, start over on a turn
    travel = Math.sign(dy) === Math.sign(travel) ? travel + dy : dy

    if (y < SHOW_NEAR_TOP || !canHide()) hidden.value = false
    else if (travel > TURN_DISTANCE) hidden.value = true
    else if (travel < -TURN_DISTANCE) hidden.value = false
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(check)
  }

  onMounted(() => {
    lastY = Math.max(0, window.scrollY)
    window.addEventListener('scroll', schedule, { passive: true })
  })
  onUnmounted(() => {
    window.removeEventListener('scroll', schedule)
    cancelAnimationFrame(frame)
  })

  return { hidden }
}
