// The screen's refresh rate, measured in the browser (there's no API that
// reports it): the browser draws a frame per screen refresh, so timing a few
// dozen requestAnimationFrame callbacks gives the rate. This also catches
// cases like iPhone Low Power Mode, which caps the screen at 30 Hz.

import { ref } from 'vue'

/** Refresh rates screens actually use; a measurement close to one is snapped to it */
const COMMON_RATES = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240]
/** Frame intervals timed per measurement (~1 s at 60 Hz) */
const SAMPLES = 60

/** Measured refresh rate in Hz; null until the first measurement finishes */
export const screenHz = ref<number | null>(null)

let measuring = false

function snap(hz: number): number {
  const near = COMMON_RATES.find((rate) => Math.abs(rate - hz) / rate < 0.04)
  return near ?? Math.round(hz)
}

/** Times SAMPLES frames and updates `screenHz`. Skipped while the tab is hidden (frames stop). */
export function measureScreenHz() {
  if (measuring || document.hidden) return
  measuring = true
  const times: number[] = []

  function onFrame(time: number) {
    times.push(time)
    if (times.length <= SAMPLES) {
      requestAnimationFrame(onFrame)
      return
    }
    measuring = false
    const intervals = times
      .slice(1)
      .map((t, i) => t - (times[i] ?? t))
      .sort((a, b) => a - b)
    // the median ignores frames the page itself dropped while busy
    const median = intervals[Math.floor(intervals.length / 2)] ?? 0
    if (median > 0) screenHz.value = snap(1000 / median)
  }
  requestAnimationFrame(onFrame)
}

/**
 * Measures now, and again whenever the tab comes back into view (the device
 * may have changed mode, e.g. Low Power Mode, or the window another screen)
 */
export function trackScreenHz() {
  measureScreenHz()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) measureScreenHz()
  })
}
