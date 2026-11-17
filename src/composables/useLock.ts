import { computed, nextTick, ref } from 'vue'
import { logout } from '@/api'
import { disconnectJobEvents } from '@/composables/useJobEvents'
import { captureResume } from '@/composables/useResume'

/**
 * Whether the lock screen or the gallery is shown (Root.vue), the countdown
 * until the app locks by itself, and locking from inside the gallery
 * (double-tapping the lock timer in the top bar).
 */

export type LockState = 'checking' | 'locked' | 'unlocked'

export const lockState = ref<LockState>('checking')

// ── Countdown ──
// The server decides when the session ends (Settings → Server → Lock screen
// → Lock after) and refuses every request after it; it says how long is
// left, and this counts that down on this device's clock. At zero the lock
// screen comes back.

/** When this session locks by itself (this device's Date.now()); null = never */
const deadline = ref<number | null>(null)
const now = ref(Date.now())
let ticker: number | undefined

/** ms until the app locks by itself; null if it never does (or it's locked) */
export const lockTimeLeft = computed(() =>
  deadline.value === null ? null : Math.max(0, deadline.value - now.value),
)

function stopLockTimer() {
  clearInterval(ticker)
  ticker = undefined
  deadline.value = null
}

/** Starts counting down `remainingMs` (from the server); null = the session never ends */
export function startLockTimer(remainingMs: number | null) {
  stopLockTimer()
  if (remainingMs === null) return
  now.value = Date.now()
  deadline.value = now.value + remainingMs
  // from the clock rather than counting ticks: timers are slowed in
  // background tabs and stop while the device sleeps
  ticker = window.setInterval(() => {
    now.value = Date.now()
    if (deadline.value !== null && now.value >= deadline.value) {
      // the server already refuses this session: nothing to log out
      void showLockScreen()
    }
  }, 1000)
}

// ── Locking ──

/**
 * Shows the lock screen with the unlock animation in reverse: the gallery
 * shrinks and fades away while the lock screen settles in from slightly
 * bigger.
 *
 * Done with a view transition (the browser animates a picture of the screen
 * before and after) rather than by scaling the gallery itself: scaling it
 * would make its fixed parts (sky, bars, an open dialog) jump when the page
 * is scrolled. Without view transitions, or with reduced motion, the lock
 * screen just appears.
 */
async function showLockScreen(): Promise<void> {
  if (lockState.value !== 'unlocked') return
  stopLockTimer()
  // where everything is, while it's all still on screen (and fullscreen):
  // unlocking comes back exactly here (useResume)
  captureResume()

  const swap = async () => {
    lockState.value = 'locked'
    await nextTick()
  }
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!('startViewTransition' in document) || reduceMotion) {
    await swap()
  } else {
    // the animation's CSS (Root.vue) applies only while this class is on
    const root = document.documentElement
    root.classList.add('locking')
    try {
      await document.startViewTransition(swap).finished
    } catch {
      // skipped (e.g. the tab was hidden): the lock screen is shown anyway
    } finally {
      root.classList.remove('locking')
    }
  }

  // the gallery is gone; its preview stream would be refused from now on
  disconnectJobEvents()
}

/**
 * Forgets the login on this browser and shows the lock screen (Lock now).
 * Throws if the server couldn't be reached.
 */
export async function lockNow(): Promise<void> {
  await logout()
  await showLockScreen()
}
