import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { haptic } from '@/utils/haptics'

/** The parts of the Screen Orientation API used here (not in every TS lib / browser) */
interface Orientation {
  type: string
  lock?: (orientation: string) => Promise<void>
  unlock?: () => void
}

function getOrientation(): Orientation | null {
  return (screen.orientation as unknown as Orientation | undefined) ?? null
}

/** Rotation needs the orientation lock API, which only works on phones/tablets */
function rotationSupported(): boolean {
  return (
    typeof getOrientation()?.lock === 'function' && window.matchMedia('(pointer: coarse)').matches
  )
}

/** State and actions of a <video>, mirrored into refs the template can use */
export function useVideoPlayer(video: Ref<HTMLVideoElement | null>, root: Ref<HTMLElement | null>) {
  const playing = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const muted = ref(false)
  const fullscreen = ref(false)
  const failed = ref(false)
  /** Parts of the video already downloaded, in seconds (for the slider's lighter bar) */
  const buffered = ref<Array<{ start: number; end: number }>>([])
  /**
   * Why the picture isn't moving when it should, or null if it's fine:
   * - 'seeking': jumping to a new position (finding a keyframe, decoding up to it)
   * - 'loading': waiting for data that isn't downloaded yet
   * - 'decoding': the data is there, but the device's decoder is behind
   *   (a high bitrate / resolution, or a fast playback speed)
   */
  const stall = ref<'seeking' | 'loading' | 'decoding' | null>(null)
  const canRotate = rotationSupported()

  /** Copies the element's state. Bind it to the <video>'s media events (incl. `progress`). */
  function sync() {
    const el = video.value
    if (!el) return
    playing.value = !el.paused && !el.ended
    currentTime.value = el.currentTime
    duration.value = Number.isFinite(el.duration) ? el.duration : 0
    muted.value = el.muted
    const ranges: Array<{ start: number; end: number }> = []
    for (let i = 0; i < el.buffered.length; i++) {
      ranges.push({ start: el.buffered.start(i), end: el.buffered.end(i) })
    }
    buffered.value = ranges
    stall.value = stallReason(el, ranges)
  }

  function stallReason(
    el: HTMLVideoElement,
    ranges: Array<{ start: number; end: number }>,
  ): 'seeking' | 'loading' | 'decoding' | null {
    if (failed.value) return null
    if (el.seeking) return 'seeking'
    // playing (or about to), but without enough data to move on
    const wantsToPlay = !el.paused && !el.ended
    if (!wantsToPlay || el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return null
    // more than a second downloaded past this point: the network isn't the problem
    const t = el.currentTime
    const ahead = ranges.find((r) => r.start <= t + 0.1 && r.end > t)
    return ahead && ahead.end - t > 1 ? 'decoding' : 'loading'
  }

  function togglePlay() {
    const el = video.value
    if (!el) return
    haptic('tap')
    if (el.paused || el.ended) el.play().catch(() => {})
    else el.pause()
  }

  function seekTo(time: number) {
    const el = video.value
    if (!el) return
    el.currentTime = Math.min(Math.max(time, 0), duration.value)
    sync()
  }

  function seekBy(delta: number) {
    seekTo(currentTime.value + delta)
  }

  function toggleMute() {
    const el = video.value
    if (!el) return
    el.muted = !el.muted
    sync()
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else root.value?.requestFullscreen().catch(() => {})
  }

  /**
   * Flips between portrait and landscape. Browsers only allow locking the
   * orientation in fullscreen, so this enters fullscreen first.
   */
  async function rotate() {
    const orientation = getOrientation()
    if (!orientation?.lock) return
    try {
      if (!document.fullscreenElement) await root.value?.requestFullscreen()
      await orientation.lock(orientation.type.startsWith('landscape') ? 'portrait' : 'landscape')
    } catch {
      // not allowed on this device / browser
    }
  }

  function onFullscreenChange() {
    fullscreen.value = document.fullscreenElement !== null && document.fullscreenElement === root.value
    // leaving fullscreen gives the rotation back to the device
    if (!document.fullscreenElement) getOrientation()?.unlock?.()
  }

  function onError() {
    failed.value = true
  }

  onMounted(() => {
    // start muted: muted autoplay is always allowed, so playback starts right away
    if (video.value) video.value.muted = true
    sync()
    document.addEventListener('fullscreenchange', onFullscreenChange)
  })
  onUnmounted(() => document.removeEventListener('fullscreenchange', onFullscreenChange))

  return {
    playing,
    currentTime,
    duration,
    muted,
    fullscreen,
    failed,
    buffered,
    stall,
    canRotate,
    sync,
    togglePlay,
    seekTo,
    seekBy,
    toggleMute,
    toggleFullscreen,
    rotate,
    onError,
  }
}
