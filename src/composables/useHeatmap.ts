import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'
import { fetchHeatmap, sendHeatmap } from '@/api'
import { recordsVideoData } from '@/appMode'
import { HEATMAP_BINS, HEATMAP_FLUSH_MS, HEATMAP_MAX_ADD } from '@/constants'

/** Longest step between two updates that's still normal playback (they come ~4× a second) */
const MAX_WATCH_STEP_S = 1.5

/**
 * A video's "most watched parts", like YouTube's heatmap over the seek bar.
 * The video is cut into HEATMAP_BINS equal parts; a part counts once each time
 * playback runs through it (seeking back over it, or a loop, counts again;
 * pausing in it doesn't, and skipped parts don't count). What's watched is
 * sent to the server every HEATMAP_FLUSH_MS, when the page is hidden and when
 * the player closes, and shows on the slider right away.
 *
 * Call `onTimeUpdate`, `onSeeked` and `onPlaying` from the <video>'s events of
 * the same names. `path` is the video's path in the listing; the lightbox
 * makes a new player per video, so it's read once.
 */
export function useHeatmap(path: string | undefined, video: Ref<HTMLVideoElement | null>) {
  /** Totals from the server (null: never watched, or not loaded) */
  const saved = ref<number[] | null>(null)
  /** Watched in this opening and not sent yet */
  const pending = ref<number[]>(new Array<number>(HEATMAP_BINS).fill(0))

  /** Position at the last update; null right after a seek */
  let lastTime: number | null = null
  /** Part counted last; null after a jump, so the part landed in counts again */
  let lastBin: number | null = null

  function binOf(time: number, duration: number): number {
    return Math.min(HEATMAP_BINS - 1, Math.max(0, Math.floor((time / duration) * HEATMAP_BINS)))
  }

  function onTimeUpdate() {
    const el = video.value
    if (!el || !path) return
    // dev mode: nothing is recorded; the next part played after switching back
    // to goon counts as a new visit
    if (!recordsVideoData.value) {
      lastTime = null
      lastBin = null
      return
    }
    const t = el.currentTime
    const duration = el.duration
    if (!Number.isFinite(duration) || duration <= 0) return
    if (!el.paused && !el.seeking && lastTime !== null) {
      const step = t - lastTime
      if (step > 0 && step <= MAX_WATCH_STEP_S) {
        // every part passed since the last update (a short video's parts are shorter than a step)
        const counts = pending.value
        for (let b = binOf(lastTime, duration); b <= binOf(t, duration); b++) {
          if (b === lastBin) continue
          counts[b] = Math.min(HEATMAP_MAX_ADD, (counts[b] ?? 0) + 1)
          lastBin = b
        }
      } else {
        // backwards (a loop) or a jump: the next part played counts as a new visit
        lastBin = null
      }
    }
    lastTime = t
  }

  function onSeeked() {
    lastTime = video.value?.currentTime ?? null
    lastBin = null
  }

  function onPlaying() {
    // resuming after a pause: the same part doesn't count twice
    lastTime = video.value?.currentTime ?? null
  }

  /** Sends what was watched since the last time, and keeps showing it */
  function flush() {
    if (!path) return
    const counts = pending.value
    if (!counts.some((n) => n > 0)) return
    pending.value = new Array<number>(HEATMAP_BINS).fill(0)
    const base = saved.value ?? new Array<number>(HEATMAP_BINS).fill(0)
    saved.value = base.map((n, i) => n + (counts[i] ?? 0))
    sendHeatmap(path, counts).catch((e: unknown) => console.warn(e))
  }

  /** Totals including this opening; null if nothing was ever watched */
  const counts = computed<number[] | null>(() => {
    const live = pending.value
    const base = saved.value
    if (!base && !live.some((n) => n > 0)) return null
    return live.map((n, i) => n + (base?.[i] ?? 0))
  })

  const controller = new AbortController()
  let timer: ReturnType<typeof setInterval> | undefined

  function onVisibility() {
    if (document.visibilityState === 'hidden') flush()
  }

  onMounted(() => {
    if (path) {
      fetchHeatmap(path, controller.signal)
        .then((loaded) => {
          if (!loaded) return
          // a flush may have happened meanwhile: add what it kept
          const local = saved.value
          saved.value = local ? loaded.map((n, i) => n + (local[i] ?? 0)) : loaded
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) console.warn(e)
        })
    }
    timer = setInterval(flush, HEATMAP_FLUSH_MS)
    document.addEventListener('visibilitychange', onVisibility)
  })

  onUnmounted(() => {
    controller.abort()
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
    flush()
  })

  return { counts, onTimeUpdate, onSeeked, onPlaying }
}
