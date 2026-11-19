<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppModeButton from '@/components/AppModeButton.vue'
import LockTimer from '@/components/LockTimer.vue'
import NightSky from '@/components/NightSky.vue'
import VideoScrubber from '@/components/VideoScrubber.vue'
import ViewPop from '@/components/ViewPop.vue'
import { recordsVideoData } from '@/appMode'
import { useAutoHide } from '@/composables/useAutoHide'
import { useContainedInset } from '@/composables/useContainedInset'
import { useHeatmap } from '@/composables/useHeatmap'
import { useHoldSeek } from '@/composables/useHoldSeek'
import { onCaptureResume, type ViewerResume } from '@/composables/useResume'
import { useVideoPlayer } from '@/composables/useVideoPlayer'
import { settings } from '@/settings'
import { formatDuration } from '@/utils/format'
import { haptic } from '@/utils/haptics'

/**
 * `poster` is shown until the first frame decodes (the grid's still, already
 * cached); `quality` ("1080p", "4K60"…) is shown at the top right in
 * fullscreen (outside it, the viewer shows it).
 * `resume`: this video was open when the app locked; it goes back to that
 * time, paused or playing as it was, and fullscreen if it was.
 * `aspect`: the video's width / height (from the listing), so the player
 * takes its shape before it loads; null if unknown (then measured on load)
 */
const props = defineProps<{
  src: string
  /** The video's path in the listing, for its "most watched parts" over the slider */
  path?: string
  poster?: string
  storyboard?: string
  quality?: string | null
  resume?: ViewerResume | null
  aspect?: number | null
}>()

/** The video's own width / height as the browser plays it, once loaded */
const loadedAspect = ref<number | null>(null)

/**
 * The player box's shape: the video's own, so a portrait one isn't between
 * wide black bars. The browser's measurement wins once it's known (it's what
 * is actually drawn); the listing's gives the box its shape before that
 */
const boxAspect = computed(() => loadedAspect.value || props.aspect || 16 / 9)
/**
 * `played`: enough of the video was watched to count as a view (Settings →
 * Most played → Counts as a view after); once per opening.
 * `controls`: the controls were shown or hidden (also once at the start).
 * The viewer shows and hides everything it puts over the video with them
 * (MediaLightbox.vue, "What's over the photo / video").
 * `watched`: it just played on for `ms` more, for its time watched (App.vue
 * adds them up): once the view counts, the seconds that made it, then each
 * small step of normal playback. Not in dev mode
 */
const emit = defineEmits<{ played: []; controls: [visible: boolean]; watched: [ms: number] }>()

const root = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)

const {
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
} = useVideoPlayer(video, root)

// Fullscreen: the player fills the screen and the video is fitted inside it,
// so a video of another shape leaves bands. What's drawn over the video (the
// lock timer, the app mode, the resolution) goes inside the video, not in them
const inset = useContainedInset(root, () => (fullscreen.value ? boxAspect.value : null))

// ── Most watched parts (drawn over the slider, like YouTube) ──
const heatmap = useHeatmap(props.path, video)

/** Already reported as played: once per opening (the lightbox makes a new player per video) */
let reportedPlay = false

// ── Coming back after a lock (useResume) ──

onCaptureResume(() => ({
  videoTime: video.value?.currentTime ?? null,
  videoPaused: video.value?.paused ?? false,
  videoFullscreen: fullscreen.value,
}))

/** The resume's time and pause were put back (once, when the video's length is known) */
let resumed = false

function onMetadata() {
  sync()
  const el = video.value
  if (el?.videoWidth && el.videoHeight) loadedAspect.value = el.videoWidth / el.videoHeight
  const r = props.resume
  if (!r || resumed || r.videoTime === null) return
  resumed = true
  seekTo(r.videoTime)
  // paused before it starts: autoplay then doesn't start it
  if (r.videoPaused) video.value?.pause()
}

// ── Counting a view, then the time watched ──
// Only time actually watched adds up: the position moving forward by small
// steps while it plays. Pauses add nothing, and skips, seeks and fast hold
// seeking (big jumps between two updates) don't count. It's a total over the
// opening, not one stretch: a seek doesn't start it over.
// Once it reaches the view's threshold (the "+1"), the time watched starts:
// those seconds are reported at once, then every step after them.

/** Seconds of the video watched so far in this opening (until the view counts) */
let watched = 0
/** Position at the last update; null right after a seek */
let lastTime: number | null = null
/** Longest step between two updates that's still normal playback (they come ~4× a second) */
const MAX_WATCH_STEP_S = 1.5

/** Seconds that have to be watched: the setting, or 90% of a shorter video */
function viewThreshold(duration: number): number {
  const wanted = settings.viewAfterSeconds
  return Number.isFinite(duration) && duration > 0 ? Math.min(wanted, duration * 0.9) : wanted
}

function trackWatched() {
  const el = video.value
  if (!el) return
  // dev mode: no view is counted, so no "+1" and no time watched either (src/appMode.ts)
  if (!recordsVideoData.value) {
    lastTime = null
    return
  }
  const t = el.currentTime
  let step = 0
  if (!el.paused && !el.seeking && lastTime !== null) {
    const moved = t - lastTime
    // backwards (a loop, a seek back) or a jump: not watched
    if (moved > 0 && moved <= MAX_WATCH_STEP_S) step = moved
  }
  lastTime = t
  // the view counted already: this step is time watched
  if (reportedPlay) {
    if (step > 0) emit('watched', step * 1000)
    return
  }
  watched += step
  if (watched >= viewThreshold(el.duration)) {
    reportedPlay = true
    emit('played')
    viewPop.value = true
    // the time watched starts now, with the seconds that made the view
    if (watched > 0) emit('watched', watched * 1000)
  }
}

/** The "+1" eye rising over the video (ViewPop.vue, with its haptics): shown once, when the view counts */
const viewPop = ref(false)

function onTimeUpdate() {
  sync()
  trackWatched()
  heatmap.onTimeUpdate()
}

function onSeeked() {
  sync()
  lastTime = video.value?.currentTime ?? null
  heatmap.onSeeked()
}

function onPlaying() {
  sync()
  lastTime = video.value?.currentTime ?? null
  heatmap.onPlaying()
  // 0 seconds: it counts as soon as it plays
  trackWatched()
}

// ── Loading indicator ──
// Shown only once a stall lasts STALL_SHOW_MS, so the tiny waits of normal
// playback and of each hold-seek step don't make it flicker
const STALL_SHOW_MS = 300
const STALL_TEXT = { seeking: 'Seeking', loading: 'Loading', decoding: 'Decoding' } as const
const shownStall = ref<keyof typeof STALL_TEXT | null>(null)
let stallTimer: ReturnType<typeof setTimeout> | undefined

watch(stall, (reason) => {
  clearTimeout(stallTimer)
  if (!reason) {
    shownStall.value = null
    return
  }
  // already showing: just update the reason
  if (shownStall.value) shownStall.value = reason
  else stallTimer = setTimeout(() => (shownStall.value = stall.value), STALL_SHOW_MS)
})

// ── Hold a side to seek (speed grows as the finger slides away) ──
const holdSeek = useHoldSeek(video, sync)
const { holding } = holdSeek

// ── Controls visibility ──
const scrubbing = ref(false)
const {
  visible: controlsVisible,
  show: showControls,
  toggle: toggleControls,
} = useAutoHide(
  () => settings.controlsHideDelayMs,
  // stay up while the slider is dragged or a side is held, to show the position
  () => !scrubbing.value && !holding.value,
)
// the viewer's counter and lock timer follow them (MediaLightbox.vue)
watch(controlsVisible, (visible) => emit('controls', visible), { immediate: true })

function onScrubStart() {
  scrubbing.value = true
  showControls()
}

function onScrubEnd() {
  scrubbing.value = false
  showControls()
}

// ── Sound: asks first ──
// Turning the sound on asks to confirm, once per opening of this video: the
// lightbox makes a new player for each item, so swapping to another video
// and back, or closing the viewer and opening it again, asks again. Turning
// it off never asks. Drawn inside the player, so it shows in fullscreen too

/** The "Turn on the sound?" popup is showing */
const confirmingSound = ref(false)
/** Sound was confirmed for this opening: it can be turned on again without asking */
let soundConfirmed = false

/** The sound button (or the M key) */
function onSoundToggle() {
  if (!muted.value || soundConfirmed) {
    toggleMute()
    return
  }
  confirmingSound.value = true
  showControls()
}

function confirmSound() {
  confirmingSound.value = false
  soundConfirmed = true
  // the tap on "Turn on" is the gesture the browser wants for sound
  toggleMute()
}

function cancelSound() {
  confirmingSound.value = false
}

// ── "+10s" bubble ──
type Side = 'back' | 'forward'
const feedback = ref<Side | null>(null)
const feedbackKey = ref(0) // restarts the fade on every tap
let feedbackTimer: ReturnType<typeof setTimeout> | undefined

function skip(side: Side) {
  const step = settings.seekStepSeconds
  haptic('tick')
  seekBy(side === 'back' ? -step : step)
  feedback.value = side
  feedbackKey.value++
  clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => (feedback.value = null), settings.seekFeedbackMs)
}

// ── Input ──

let lastTap: { side: Side; at: number } | null = null
let pendingToggle: ReturnType<typeof setTimeout> | undefined

function sideAt(e: MouseEvent): Side | null {
  const el = root.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  if (x < settings.seekTapZone) return 'back'
  if (x > 1 - settings.seekTapZone) return 'forward'
  return null
}

// A press on a side becomes a hold after holdSeekDelayMs; released sooner it
// stays a tap (handled by onTap from the click that follows)
let holdTimer: ReturnType<typeof setTimeout> | undefined
let holdPointer: number | null = null
/** The click that follows a hold's release must not count as a tap */
let swallowClick = false

function onPressStart(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  const side = sideAt(e)
  if (!side || holdPointer !== null) return
  holdPointer = e.pointerId
  // keep getting this finger's moves even if it slides off the video
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  const x = e.clientX
  const y = e.clientY
  clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    holdTimer = undefined
    // it was the second tap of a double tap: no pending single-tap toggle
    clearTimeout(pendingToggle)
    pendingToggle = undefined
    lastTap = null
    haptic('tick') // hold-to-seek starts
    holdSeek.start(side, x, y)
    showControls()
  }, settings.holdSeekDelayMs)
}

function onPressMove(e: PointerEvent) {
  if (e.pointerId === holdPointer) holdSeek.move(e.clientX, e.clientY)
}

function onPressEnd(e: PointerEvent) {
  if (e.pointerId !== holdPointer) return
  holdPointer = null
  clearTimeout(holdTimer)
  holdTimer = undefined
  if (holding.value) {
    holdSeek.end()
    swallowClick = true
    showControls()
  }
}

/**
 * A single tap shows/hides the controls (it never plays or pauses).
 * A double tap on the left/right side seeks; keep tapping to keep seeking.
 */
function onTap(e: MouseEvent) {
  if (swallowClick) {
    swallowClick = false
    return
  }
  const side = sideAt(e)
  const now = performance.now()

  if (side && lastTap?.side === side && now - lastTap.at < settings.doubleTapMs) {
    clearTimeout(pendingToggle)
    pendingToggle = undefined
    skip(side)
    lastTap = { side, at: now }
    return
  }

  lastTap = side ? { side, at: now } : null
  clearTimeout(pendingToggle)
  if (!side) {
    toggleControls()
    return
  }
  // might be the first half of a double tap: wait before toggling
  pendingToggle = setTimeout(() => {
    pendingToggle = undefined
    toggleControls()
  }, settings.doubleTapMs)
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerType === 'mouse') showControls()
}

function onKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case ' ':
    case 'k':
      togglePlay()
      break
    case 'ArrowLeft':
      skip('back')
      break
    case 'ArrowRight':
      skip('forward')
      break
    case 'f':
      toggleFullscreen()
      break
    case 'm':
      onSoundToggle()
      break
    case 'Enter':
      // the sound popup is open: Enter confirms it
      if (!confirmingSound.value) return
      confirmSound()
      break
    default:
      return
  }
  e.preventDefault()
  showControls()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // it was fullscreen when the app locked: right away, while the unlock's
  // tap still counts as the gesture fullscreen needs (refused later on)
  if (props.resume?.videoFullscreen) toggleFullscreen()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(feedbackTimer)
  clearTimeout(pendingToggle)
  clearTimeout(holdTimer)
  clearTimeout(stallTimer)
})
</script>

<template>
  <div
    ref="root"
    class="player"
    :class="{ 'controls-hidden': !controlsVisible, fullscreen }"
    :style="{
      '--aspect': boxAspect,
      '--media-inset-x': `${inset.x.value}px`,
      '--media-inset-y': `${inset.y.value}px`,
    }"
    @pointermove="onPointerMove"
  >
    <!-- fullscreen: the night sky around the video instead of black -->
    <NightSky v-if="fullscreen" ignore-pause />

    <!-- the view just counted: an eye with "+1" pops in, glows, rises and fades;
         inside the player, so it shows in fullscreen too -->
    <ViewPop v-if="viewPop" @done="viewPop = false" />

    <video
      ref="video"
      :src="src"
      :poster="poster"
      autoplay
      muted
      playsinline
      :loop="settings.loopVideos"
      preload="auto"
      @play="sync"
      @pause="sync"
      @ended="sync"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onMetadata"
      @durationchange="sync"
      @volumechange="sync"
      @seeked="onSeeked"
      @seeking="sync"
      @waiting="sync"
      @stalled="sync"
      @playing="onPlaying"
      @canplay="sync"
      @progress="sync"
      @error="onError"
    />

    <!-- tap: show/hide the controls; double tap on a side: skip; hold a side: seek -->
    <div
      class="tap-layer"
      @click="onTap"
      @pointerdown="onPressStart"
      @pointermove="onPressMove"
      @pointerup="onPressEnd"
      @pointercancel="onPressEnd"
      @contextmenu.prevent
    />

    <!-- while holding: direction and speed -->
    <div v-if="holding" class="hold-indicator theme-glass" :class="holding.side">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path v-if="holding.side === 'forward'" d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
        <path v-else d="M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z" />
      </svg>
      {{ holding.speed.toFixed(1) }}×
    </div>

    <div
      v-if="feedback"
      :key="feedbackKey"
      class="seek-feedback theme-glass"
      :class="feedback"
      :style="{ animationDuration: `${settings.seekFeedbackMs}ms` }"
    >
      {{ feedback === 'back' ? '−' : '+' }}{{ settings.seekStepSeconds }}s
    </div>

    <div v-if="failed" class="error">Can't play this video</div>

    <!-- turning the sound on: asks first (once per opening of this video).
         Taps here don't reach the video or the viewer behind it -->
    <div
      v-if="confirmingSound"
      class="sound-confirm-backdrop"
      @click.stop.self="cancelSound"
      @pointerdown.stop
    >
      <div
        class="sound-confirm theme-glass"
        role="alertdialog"
        aria-labelledby="sound-confirm-title"
        @click.stop
      >
        <p id="sound-confirm-title" class="sound-confirm-title">Turn on the sound?</p>
        <p class="sound-confirm-text">Are you sure you want to play this video with sound?</p>
        <div class="sound-confirm-actions">
          <button type="button" class="sound-confirm-cancel" @click="cancelSound">Cancel</button>
          <button type="button" class="sound-confirm-ok" @click="confirmSound">Turn on</button>
        </div>
      </div>
    </div>

    <!-- stuck: spinner, and why (so a freeze with plenty downloaded makes sense) -->
    <div v-if="shownStall" class="stall theme-glass" role="status">
      <span class="spinner" />
      <span class="stall-text">{{ STALL_TEXT[shownStall] }}</span>
    </div>

    <!-- fullscreen, top left: the time left until the app locks (shows and
         hides with the controls) and the app mode with its image (always
         shown, even when the controls are hidden). The viewer's own are
         outside fullscreen -->
    <div v-if="fullscreen" class="player-status">
      <LockTimer class="player-timer control theme-glass" />
      <AppModeButton class="player-mode theme-glass" />
    </div>
    <!-- fullscreen: the resolution at the top right (outside fullscreen the
         viewer shows its own, MediaLightbox.vue) -->
    <span
      v-if="fullscreen && quality"
      class="player-quality control theme-glass"
      title="Video quality"
      >{{ quality }}</span
    >

    <button
      class="center-play control theme-glass"
      :aria-label="playing ? 'Pause' : 'Play'"
      @click="togglePlay"
    >
      <svg v-if="playing" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
      <svg v-else viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
    </button>

    <div class="controls control" @pointerdown="showControls">
      <VideoScrubber
        :src="src"
        :storyboard="storyboard"
        :current-time="currentTime"
        :duration="duration"
        :buffered="buffered"
        :heatmap="heatmap.counts.value"
        :media="video"
        @seek="seekTo"
        @scrub-start="onScrubStart"
        @scrub-end="onScrubEnd"
      />

      <div class="bar">
        <button class="theme-glass" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
          <svg v-if="playing" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </button>

        <span class="time theme-glass">
          {{ formatDuration(currentTime) || '0:00' }} / {{ formatDuration(duration) || '0:00' }}
        </span>

        <span class="spacer" />


        <button class="theme-glass" :aria-label="muted ? 'Unmute' : 'Mute'" @click="onSoundToggle">
          <svg v-if="muted" viewBox="0 0 24 24">
            <path
              d="M3 9v6h4l5 5V4L7 9H3zm16.6 3 2.4-2.4-1.4-1.4-2.4 2.4-2.4-2.4-1.4 1.4 2.4 2.4-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4 1.4-1.4z"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" />
          </svg>
        </button>

        <!-- fullscreen only: not in the carousel -->
        <button
          v-if="canRotate && fullscreen"
          class="theme-glass"
          aria-label="Rotate"
          @click="rotate"
        >
          <svg viewBox="0 0 24 24">
            <path
              d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77a1.49 1.49 0 0 0-2.12 0L1.75 8.11a1.49 1.49 0 0 0 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36a1.49 1.49 0 0 0 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"
            />
          </svg>
        </button>

        <button
          class="theme-glass"
          :aria-label="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
          @click="toggleFullscreen"
        >
          <svg v-if="fullscreen" viewBox="0 0 24 24">
            <path
              d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24">
            <path
              d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
            />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Every video gets a box of its own shape (--aspect: width / height, set
   from the video), as big as the space allows (the lightbox sets
   --media-max-width / --media-max-height), whatever its resolution: a 480p
   video plays as big as a 4K one, and a portrait one is a tall box instead
   of a 16:9 one with wide black bars */
.player {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: var(--aspect, 16 / 9);
  width: min(
    var(--media-max-width, 100vw),
    calc(var(--media-max-height, 85vh) * var(--aspect, 16 / 9))
  );
  max-width: 100%;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
  cursor: default;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

/* fills the box, scaled to fit with its own shape kept */
.player video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Fullscreen: not black around a video that doesn't fill the screen (a
   portrait one, say), but the night sky, like the lock screen: its own
   NightSky, behind the video (isolation keeps the canvas's z-index -1 in here) */
.player.fullscreen {
  aspect-ratio: auto;
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  isolation: isolate;
  background: var(--page-bg);
}

.player.fullscreen video {
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: contain;
}

.player.controls-hidden {
  cursor: none;
}

svg {
  width: 22px;
  height: 22px;
  fill: currentColor;
}

/* ── Layers ── */
.tap-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  /* the browser handles no gestures here: double taps aren't zooms, and a
     hold-and-slide isn't taken over as a scroll (which would cancel it) */
  touch-action: none;
  /* no iOS long-press callout / text magnifier while holding */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
}

/* ── Loading indicator ── */
/* sits above the center play button's spot, so both can show */
.stall {
  position: absolute;
  top: calc(50% - 64px);
  left: 50%;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  transform: translate(-50%, -50%);
  padding: 0.4rem 0.8rem 0.4rem 0.55rem;
  border-radius: 999px;
  /* colored glass: .theme-glass (tokens.css), like the rest of the controls */
  color: #fff;
  font-size: 0.78rem;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}

.spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Hold-to-seek indicator ── */
.hold-indicator {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  transform: translateY(-50%);
  padding: 0.55rem 0.95rem;
  border-radius: 999px;
  color: #fff;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}

.hold-indicator.back {
  left: 10%;
}

.hold-indicator.forward {
  right: 10%;
}

.control {
  z-index: 3;
  /* the viewer fades its counter and lock timer the same (MediaLightbox.vue) */
  transition: opacity var(--overlay-fade);
}

.player.controls-hidden .control {
  opacity: 0;
  pointer-events: none;
}

/* ── Lock countdown and app mode (fullscreen) ── */
/* pinned to the screen's top left, side by side. The row lets taps through
   (to the video under it); only the mode takes them. Not a .control: the mode
   stays when the controls hide (the timer, a .control, fades by itself) */
.player-status {
  position: absolute;
  z-index: 3;
  /* inside the video: past the bands a differently shaped video leaves (useContainedInset) */
  top: calc(var(--media-inset-y, 0px) + 1rem);
  left: calc(var(--media-inset-x, 0px) + 1rem);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  pointer-events: none;
  /* the pills' height (one line, padding, 1px rim): the mode's image
     (AppModeImage.vue) is a circle this big, so all three line up */
  --mode-image-size: calc(0.8rem * 1.25 + 0.6rem + 2px);
}

.player-status :deep(.app-mode-group) {
  pointer-events: auto;
}

/* the mode's pill: the same as the lock timer beside it (the pill is inside
   AppModeButton, where this file's scoped styles reach only with :deep) */
.player-status :deep(.player-mode) {
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.8rem;
  line-height: 1.25;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

/* when the controls hide, the timer shrinks away to nothing, so the app mode
   beside it slides left into its room, keeping the breathing space from the
   video's edge (the same as from its top) */
.player-timer {
  max-width: 10rem;
  overflow: hidden;
  transition:
    opacity var(--overlay-fade),
    max-width var(--overlay-fade),
    padding var(--overlay-fade),
    margin var(--overlay-fade);
}

.player.controls-hidden .player-timer {
  max-width: 0;
  padding-left: 0;
  padding-right: 0;
  border-left-width: 0;
  border-right-width: 0;
  /* the gap beside it goes too */
  margin-right: -0.4rem;
}

@media (prefers-reduced-motion: reduce) {
  .player-timer {
    transition: none;
  }
}

/* a pill like the time */
.player-timer {
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.8rem;
  line-height: 1.25;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}

/* ── Center play button ── */
.center-play {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 64px;
  height: 64px;
  border-radius: 50%;
  /* colored glass: .theme-glass (tokens.css), like the bottom bar's buttons */
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: filter 0.15s;
}

.center-play:hover {
  filter: brightness(1.25);
}

.center-play svg {
  width: 32px;
  height: 32px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}

/* ── Bottom controls ── */
.controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2rem 0.75rem 0.4rem;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: #fff;
}

/* buttons and the time: colored glass (.theme-glass, tokens.css), like the
   center play button and the slider's preview */
.bar button {
  display: flex;
  padding: 0.35rem;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  transition: filter 0.15s;
}

.bar button:hover {
  filter: brightness(1.25);
}

.bar button svg {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}

.time {
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

/* fullscreen: the resolution, pinned to the screen's top right, the same
   pill as the lock timer opposite it, a little bolder */
.player-quality {
  position: absolute;
  top: calc(var(--media-inset-y, 0px) + 1rem);
  right: calc(var(--media-inset-x, 0px) + 1rem);
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.8rem;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}

.spacer {
  flex: 1;
}

/* ── Seek bubble ── */
.seek-feedback {
  position: absolute;
  top: 50%;
  z-index: 2;
  transform: translateY(-50%);
  padding: 0.6rem 1rem;
  border-radius: 999px;
  color: #fff;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
  animation: seek-fade ease-out forwards;
}

.seek-feedback.back {
  left: 12%;
}

.seek-feedback.forward {
  right: 12%;
}

@keyframes seek-fade {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

/* ── Sound confirmation ── */
/* over everything in the player (controls included); a tap outside the box cancels */
.sound-confirm-backdrop {
  position: absolute;
  inset: 0;
  z-index: 7;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.45);
  animation: sound-confirm-fade 0.18s ease-out;
}

.sound-confirm {
  max-width: 18rem;
  padding: 1rem 1.1rem 0.9rem;
  border-radius: 14px;
  color: #fff;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  animation: sound-confirm-pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

.sound-confirm-title {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
  font-weight: 700;
}

.sound-confirm-text {
  margin: 0 0 0.9rem;
  font-size: 0.8rem;
  opacity: 0.85;
}

.sound-confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
}

.sound-confirm-actions button {
  padding: 0.4rem 0.9rem;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
}

.sound-confirm-actions button:hover {
  filter: brightness(1.25);
}

.sound-confirm-cancel {
  background: rgba(255, 255, 255, 0.08);
}

.sound-confirm-ok {
  background: linear-gradient(90deg, var(--theme-cyan), var(--theme-blue), var(--theme-pink));
}

@keyframes sound-confirm-fade {
  from {
    opacity: 0;
  }
}

@keyframes sound-confirm-pop {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sound-confirm {
    animation: sound-confirm-fade 0.18s ease-out;
  }
}

.error {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c0392b;
  pointer-events: none;
}
</style>
