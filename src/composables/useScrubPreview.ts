import { onUnmounted, ref, watch, type Ref } from 'vue'
import { settings } from '@/settings'

/**
 * Draws the frame at a given time onto a canvas. Uses a second, hidden
 * <video> so the main one keeps playing undisturbed while you scrub.
 * Rapid requests are collapsed: only the latest time gets rendered.
 */
export function useScrubPreview(src: Ref<string>, canvas: Ref<HTMLCanvasElement | null>) {
  const probe = document.createElement('video')
  probe.muted = true
  probe.preload = 'metadata'
  probe.playsInline = true

  /** True once at least one frame has been drawn */
  const ready = ref(false)
  let seeking = false
  let pending: number | null = null

  function draw() {
    const c = canvas.value
    const ctx = c?.getContext('2d')
    if (!c || !ctx || !probe.videoWidth) return
    const width = settings.scrubPreviewWidth
    const height = Math.round((width * probe.videoHeight) / probe.videoWidth)
    if (c.width !== width) c.width = width
    if (c.height !== height) c.height = height
    ctx.drawImage(probe, 0, 0, c.width, c.height)
    ready.value = true
  }

  function seek(time: number) {
    seeking = true
    probe.currentTime = time
  }

  function next() {
    if (pending === null) return
    const time = pending
    pending = null
    seek(time)
  }

  probe.addEventListener('seeked', () => {
    seeking = false
    draw()
    next()
  })
  probe.addEventListener('loadedmetadata', () => {
    if (!seeking) next()
  })

  // The hidden video only starts loading on the first scrub, so it doesn't
  // compete with the main video for bandwidth while that one starts playing.
  let attached = false

  function attach() {
    if (attached) return
    attached = true
    probe.src = src.value
  }

  /** Show the frame at `time` (seconds) */
  function request(time: number) {
    attach()
    if (seeking || probe.readyState < HTMLMediaElement.HAVE_METADATA) pending = time
    else seek(time)
  }

  watch(src, () => {
    ready.value = false
    seeking = false
    pending = null
    attached = false
    probe.removeAttribute('src')
  })

  onUnmounted(() => {
    probe.removeAttribute('src')
    probe.load() // stops any download
  })

  return { ready, request }
}
