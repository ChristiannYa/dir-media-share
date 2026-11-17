import { onUnmounted, ref, type Ref } from 'vue'
import { settings } from '@/settings'

export type SeekSide = 'back' | 'forward'

/**
 * Fastest rate browsers play at (Chrome refuses more than 16); above it, and
 * for going backwards, the video is stepped through with seeks instead
 */
const MAX_PLAYBACK_RATE = 16

/**
 * Continuous seeking while a side of the video is held, like Telegram's
 * player: it moves through the video at `holdSeekSpeed`, and sliding the
 * finger away from where it pressed (any direction, since there's little room
 * toward the edge) adds `holdSeekGain` per 100px, in 0.1× steps. Sliding back
 * slows it down again, never below the starting speed.
 *
 * Two ways of moving:
 * - forward up to 16×: the video simply plays faster (playbackRate), so it
 *   stays smooth and keeps downloading ahead as it goes
 * - backward, or faster than 16×: paused, stepped with seeks. Each seek is
 *   only sent once the previous frame is shown, so a slow decoder or network
 *   never builds up a queue of stale seeks
 * On release the video goes back to normal speed, and stays paused if it was.
 */
export function useHoldSeek(video: Ref<HTMLVideoElement | null>, onSeek: () => void) {
  /** What's on screen while holding; null otherwise */
  const holding = ref<{ side: SeekSide; speed: number } | null>(null)

  let startX = 0
  let startY = 0
  /** Where stepping has got to (seconds); runs ahead of the shown frame while seeks catch up */
  let position = 0
  let wasPlaying = false
  let normalRate = 1
  let mode: 'rate' | 'step' = 'step'
  let lastFrame = 0
  let frame = 0

  /** Speed for the finger at (x, y): grows with the distance from the press, rounded to 0.1× */
  function speedFor(x: number, y: number): number {
    const slid = Math.hypot(x - startX, y - startY)
    const speed = settings.holdSeekSpeed + (slid / 100) * settings.holdSeekGain
    const rounded = Math.round(speed * 10) / 10
    return Math.min(rounded, Math.max(settings.holdSeekMaxSpeed, settings.holdSeekSpeed))
  }

  /** Puts the video in the right mode for the current side and speed */
  function apply() {
    const el = video.value
    const state = holding.value
    if (!el || !state) return

    if (state.side === 'forward' && state.speed <= MAX_PLAYBACK_RATE) {
      try {
        el.playbackRate = state.speed
        if (mode === 'step') {
          // pick up from where stepping got to
          if (Math.abs(el.currentTime - position) > 0.05) el.currentTime = position
          mode = 'rate'
        }
        if (el.paused) el.play().catch(() => {})
        return
      } catch {
        // this browser refuses that rate: step instead
      }
    }
    if (mode === 'rate') position = el.currentTime
    mode = 'step'
    el.playbackRate = normalRate
    el.pause()
  }

  function tick(now: number) {
    const el = video.value
    const state = holding.value
    if (!el || !state) return
    const seconds = (now - lastFrame) / 1000
    lastFrame = now

    if (mode === 'step') {
      const end = Number.isFinite(el.duration) ? el.duration : 0
      const direction = state.side === 'forward' ? 1 : -1
      position = Math.min(Math.max(position + direction * state.speed * seconds, 0), end)
      if (!el.seeking && Math.abs(el.currentTime - position) > 0.01) {
        // at high speed, keyframe seeks (where supported) keep up much better
        if (state.speed >= 8 && typeof el.fastSeek === 'function') el.fastSeek(position)
        else el.currentTime = position
        onSeek()
      }
    }
    frame = requestAnimationFrame(tick)
  }

  /** Starts seeking toward `side`; (x, y) is where the finger pressed (clientX/Y) */
  function start(side: SeekSide, x: number, y: number) {
    const el = video.value
    if (!el || holding.value) return
    startX = x
    startY = y
    position = el.currentTime
    wasPlaying = !el.paused && !el.ended
    normalRate = el.playbackRate
    mode = 'step'
    holding.value = { side, speed: speedFor(x, y) }
    apply()
    lastFrame = performance.now()
    frame = requestAnimationFrame(tick)
  }

  /** The finger moved: adjusts the speed (and the mode, crossing 16×) */
  function move(x: number, y: number) {
    const state = holding.value
    if (!state) return
    const speed = speedFor(x, y)
    if (speed === state.speed) return
    state.speed = speed
    apply()
  }

  /** Released: back to normal speed, landing where the hold got to */
  function end() {
    const el = video.value
    if (!holding.value) return
    cancelAnimationFrame(frame)
    holding.value = null
    if (!el) return
    el.playbackRate = normalRate
    if (mode === 'step') el.currentTime = position
    onSeek()
    if (wasPlaying) el.play().catch(() => {})
    else el.pause()
  }

  onUnmounted(() => cancelAnimationFrame(frame))

  return { holding, start, move, end }
}
