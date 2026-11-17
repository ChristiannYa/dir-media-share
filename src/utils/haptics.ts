import { settings } from '@/settings'

/**
 * Light vibrations for taps and events (Settings → This device → Haptics).
 *
 * - Android (and any browser with navigator.vibrate): a short buzz.
 * - iPhone: Safari has no vibration API, but since iOS 18 toggling a
 *   `<input type="checkbox" switch>` plays the system's haptic tick. A
 *   hidden one is toggled. iOS only allows it right after a tap, so events
 *   that aren't (a preview starting) may stay silent there.
 * - Elsewhere (computers): nothing.
 *
 * How long a buzz lasts scales from Haptic strength (settings.hapticMs, a
 * tap's length): a browser can only set how long, not how strong. Phone
 * motors need ~20 ms to spin up, so much shorter is too faint to feel.
 */

export type HapticKind = 'tap' | 'tick'

const KINDS: Record<HapticKind, { share: number; gapMs: number }> = {
  /** A press: opening a folder or file, play / pause, next media, Done, lock screen keys */
  tap: { share: 1, gapMs: 40 },
  /** A small step: a skip, the start of a hold-to-seek */
  tick: { share: 0.7, gapMs: 40 },
}

/** A preview's buzz, as a share of a tap */
const PREVIEW_SHARE = 0.8
/** Stillness between two queued preview buzzes (ms), so each one is felt on its own */
const PREVIEW_GAP_MS = 140

const lastAt: Partial<Record<HapticKind, number>> = {}

const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator
/** No vibration API but a touch screen: an iPhone / iPad */
const useSwitch = !canVibrate && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0

/** Chrome refused a vibration (said once in the console, to tell it from "too faint") */
let warnedRefused = false

let iosSwitch: HTMLLabelElement | null = null

/** Toggles the hidden switch, which iOS answers with a haptic tick */
function iosTick() {
  if (!iosSwitch) {
    const label = document.createElement('label')
    label.setAttribute('aria-hidden', 'true')
    label.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    label.append(input)
    // the clicks stay here: nothing else on the page should see them
    label.addEventListener('click', (e) => e.stopPropagation())
    document.body.append(label)
    iosSwitch = label
  }
  iosSwitch.click()
}

/**
 * One buzz of `ms` now, or a pattern (buzz, pause, buzz… in ms); iPhones
 * only have one tick, whatever the pattern
 */
function buzz(ms: number | number[]) {
  try {
    if (canVibrate) {
      // false: refused, e.g. before the first tap on the page (Chrome only
      // vibrates once the page has been touched) or in a background tab
      if (!navigator.vibrate(ms) && !warnedRefused) {
        warnedRefused = true
        console.info('[haptics] the browser refused to vibrate (no tap on the page yet?)')
      }
    } else if (useSwitch) iosTick()
  } catch {
    // not allowed right now: nothing happens
  }
}

/** Vibrates for `kind` right away, if haptics are on */
export function haptic(kind: HapticKind = 'tap') {
  if (!settings.haptics) return
  const now = performance.now()
  const { share, gapMs } = KINDS[kind]
  if (now - (lastAt[kind] ?? -Infinity) < gapMs) return
  lastAt[kind] = now
  buzz(Math.round(settings.hapticMs * share))
}

/** Stillness between the two beats of a view's buzz (ms) */
const VIEW_GAP_MS = 70
/** The second beat, as a share of the first */
const VIEW_SECOND_SHARE = 0.6

/**
 * A video's view just counted (the "+1" eye, VideoPlayer.vue): a double buzz,
 * "ba-dum", so it feels different from a tap. On iPhone it may stay silent:
 * iOS only allows it right after a tap, and this comes while watching
 */
export function viewHaptic() {
  if (!settings.haptics) return
  const ms = settings.hapticMs
  buzz([ms, VIEW_GAP_MS, Math.round(ms * VIEW_SECOND_SHARE)])
}

// ── Previews ──
// One buzz per preview, the first time it plays since the page loaded
// (PreviewVideo checks that: utils/firstPlays.ts). Several often start at
// once, and a new vibration cuts off the one still running, so they wait in
// line: each buzz, then a short stillness, then the next, so 6 previews are
// 6 buzzes you can count.

/** Buzzes still waiting their turn */
let queued = 0
let draining = false

function drain() {
  if (queued === 0 || !settings.haptics) {
    queued = 0
    draining = false
    return
  }
  queued--
  draining = true
  const ms = Math.round(settings.hapticMs * PREVIEW_SHARE)
  buzz(ms)
  setTimeout(drain, ms + PREVIEW_GAP_MS)
}

/** A preview played for the first time: one buzz, queued behind the others */
export function previewHaptic() {
  if (!settings.haptics) return
  queued++
  if (!draining) drain()
}
