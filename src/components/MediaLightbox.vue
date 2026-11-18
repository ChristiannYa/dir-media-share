<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppModeButton from '@/components/AppModeButton.vue'
import LockTimer from '@/components/LockTimer.vue'
import NightSky from '@/components/NightSky.vue'
import VideoPlayer from '@/components/VideoPlayer.vue'
import ViewPop from '@/components/ViewPop.vue'
import { fileUrl, storyboardUrl, thumbUrl } from '@/api'
import { recordsVideoData } from '@/appMode'
import { useAutoHide } from '@/composables/useAutoHide'
import { useContainedInset } from '@/composables/useContainedInset'
import { onCaptureResume, takeViewerResume, type ViewerResume } from '@/composables/useResume'
import { settings } from '@/settings'
import type { Entry } from '@/types'
import { formatQuality } from '@/utils/format'
import { haptic } from '@/utils/haptics'

/**
 * The opened photo or video, full size, with a carousel of the folder's other
 * photos and videos under it to go through them: tap one, PageUp /
 * PageDown, or for photos the arrow keys and a sideways swipe (a
 * video's arrow keys and taps are its player's: skipping, seeking).
 *
 * Closed with Escape (useLightbox.ts) or a tap on the dimmed background
 * around the photo / video: there's no close button.
 *
 * What's over the photo / video: a counter at its top middle (which item this
 * is), at its top left the time left until the app locks and the app mode
 * (.media-status: both from the top bar, which the viewer covers; a tap on
 * the mode switches it), at its top right a video's resolution, and on a
 * photo a fullscreen button at its bottom right (in photo fullscreen a
 * rotate button too; videos have their player's own buttons). Downloading
 * is in a card's menu (FileMenu.vue). In photo fullscreen they're pinned to the screen's
 * corners instead, and going to the next / previous skips the videos (a
 * video's taps and swipes are its player's) and loops from the last photo to
 * the first; the counter then counts the photos. In video fullscreen the
 * player shows its own lock timer, as one of its controls.
 *
 * ONE RULE for all of it: everything over the photo / video shows, hides and
 * fades together, as one set of controls. Never give one of them its own
 * timer or its own trigger: put it inside .lightbox-frame and hide it under
 * .lightbox.overlay-off (style below), and it follows on its own.
 *  - On a video, the player's controls decide (its `controls` event): they
 *    show when it opens, a tap toggles them (on the sides after the
 *    double-tap wait), a mouse move or key shows them, and they hide after
 *    "Hide controls after" (Settings), not while the slider is dragged or a
 *    side is held. The overlay follows that, nothing else.
 *  - On a photo, the overlay's own `useAutoHide` decides, with the same
 *    delay: in the carousel hidden at first and toggled by a tap in the
 *    middle of the photo; in fullscreen shown by any tap, mouse move or key.
 *  - They fade in --overlay-fade (tokens.css), the player's controls' fade.
 *  - On a video they wear the player's colored glass (.theme-glass), like
 *    its buttons; on a photo the dark glass of the photo's buttons.
 * Only the carousel strip, outside the photo / video, always stays.
 */
const props = defineProps<{
  entry: Entry | null
  /** The folder's photos and videos, in the grid's order */
  entries: Entry[]
}>()
const emit = defineEmits<{
  close: []
  select: [entry: Entry]
  /**
   * A video was watched, or a photo seen, for the "Counts as a view after"
   * time (Settings → Most played): it counts as viewed ("last viewed", plays)
   */
  viewed: [entry: Entry]
}>()

const root = ref<HTMLElement | null>(null)
const strip = ref<HTMLElement | null>(null)

const index = computed(() =>
  props.entry ? props.entries.findIndex((e) => e.path === props.entry?.path) : -1,
)
/** The folder's photos, which photo fullscreen goes through */
const photos = computed(() => props.entries.filter((e) => e.kind === 'image'))
const photoIndex = computed(() =>
  props.entry ? photos.value.findIndex((e) => e.path === props.entry?.path) : -1,
)

/**
 * The item before (-1) or after (1) the current one. In photo fullscreen it's
 * the photo before / after, looping round at the ends: there a video couldn't
 * be swiped away from.
 */
function neighbor(step: -1 | 1): Entry | undefined {
  if (fullscreen.value) {
    const n = photos.value.length
    if (photoIndex.value < 0 || n < 2) return undefined
    return photos.value[(photoIndex.value + step + n) % n]
  }
  return index.value >= 0 ? props.entries[index.value + step] : undefined
}

const prev = computed(() => neighbor(-1))
const next = computed(() => neighbor(1))

/** Goes to another item (swipe, arrow / page keys, a carousel thumbnail), with a tap of haptics */
function go(to: Entry | undefined) {
  if (!to || to.path === props.entry?.path) return
  haptic('tap')
  emit('select', to)
}

// ── Keys ──

function onKeydown(e: KeyboardEvent) {
  if (!props.entry) return
  const isImage = props.entry.kind === 'image'
  if (e.key === 'PageUp' || (isImage && e.key === 'ArrowLeft')) go(prev.value)
  else if (e.key === 'PageDown' || (isImage && e.key === 'ArrowRight')) go(next.value)
  else if (isImage && e.key === 'f') toggleFullscreen()
  else if (isImage && fullscreen.value && e.key === 'r') rotate()
  else return
  e.preventDefault()
}

// ── Swipe (photos) ──

/** Sideways distance (px) a swipe needs to go to the next / previous photo */
const SWIPE_PX = 50
/** Most a press may move (px) and still count as a tap */
const TAP_PX = 10
/** Middle part of the photo (of its width and height) where a tap shows the buttons */
const CENTER_TAP_ZONE = 0.5
let swipeStart: { x: number; y: number } | null = null

function onSwipeStart(e: PointerEvent) {
  swipeStart = { x: e.clientX, y: e.clientY }
}

function onSwipeEnd(e: PointerEvent) {
  if (!swipeStart) return
  const dx = e.clientX - swipeStart.x
  const dy = e.clientY - swipeStart.y
  swipeStart = null
  if (Math.abs(dx) <= TAP_PX && Math.abs(dy) <= TAP_PX) {
    onPhotoTap(e)
    return
  }
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return
  go(dx < 0 ? next.value : prev.value)
}

/** Carousel: a tap in the middle of the photo shows (or hides again) its buttons and the counter */
function onPhotoTap(e: PointerEvent) {
  if (fullscreen.value) return // there any tap already shows them (onActivity)
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height
  const edge = (1 - CENTER_TAP_ZONE) / 2
  if (x >= edge && x <= 1 - edge && y >= edge && y <= 1 - edge) toggleOverlay()
}

function onSwipeCancel() {
  swipeStart = null
}

// ── Fullscreen (photos) ──

const canFullscreen = document.fullscreenEnabled
const fullscreen = ref(false)

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else root.value?.requestFullscreen().catch(() => {})
}

function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement !== null && document.fullscreenElement === root.value
  if (fullscreen.value) {
    showOverlay()
  } else {
    rotation.value = 0
    hideOverlay() // back in the carousel: hidden until the photo is tapped
  }
}

/**
 * Turn of the photo in fullscreen (0, 90, 180, 270°, clockwise), for photos
 * saved sideways. It stays while going through the photos (a series is
 * usually shot the same way) and is undone on leaving fullscreen.
 */
const rotation = ref(0)

function rotate() {
  rotation.value = (rotation.value + 90) % 360
}

const sideways = computed(() => fullscreen.value && rotation.value % 180 !== 0)

/**
 * On a photo: whether what's over it shows (the rule at the top). It fades
 * out after the player's "Hide controls after". In the carousel it starts
 * hidden and a tap in the middle of the photo toggles it; in fullscreen any
 * move, tap or key shows it
 */
const {
  visible: overlayVisible,
  show: showOverlay,
  hide: hideOverlay,
  toggle: toggleOverlay,
} = useAutoHide(() => settings.controlsHideDelayMs)
hideOverlay()

/**
 * On a video: whether the player's controls show (its `controls` event).
 * A new player starts with them shown
 */
const videoControlsVisible = ref(true)

/** What's over the photo / video shows: on a video with the player's controls, on a photo with its overlay */
const overlayShown = computed(() =>
  props.entry?.kind === 'video' ? videoControlsVisible.value : overlayVisible.value,
)
/** Photo fullscreen: the mouse pointer goes with them */
const overlayHidden = computed(() => fullscreen.value && !overlayVisible.value)

/** Which item this is: of all of them, or in photo fullscreen of the photos; '' if only one */
const counterText = computed(() => {
  if (fullscreen.value) {
    return photos.value.length > 1 ? `${photoIndex.value + 1} / ${photos.value.length}` : ''
  }
  return index.value >= 0 && props.entries.length > 1
    ? `${index.value + 1} / ${props.entries.length}`
    : ''
})

/** A video's resolution ("1080p", "4K60"…), at the top right; null for photos or if unknown */
const videoQuality = computed(() => {
  const e = props.entry
  return e?.kind === 'video' ? formatQuality(e.width, e.height, e.fps) || null : null
})

// ── Size of what's over the media ──
// The counter, the lock timer, the app mode and the resolution scale with the
// media's width (--overlay-scale): smaller on a small photo, so they don't
// cover it, and a little bigger on a large one. Fullscreen: always full size

/** Media width (px) at which they're full size */
const OVERLAY_REF_WIDTH = 640
const OVERLAY_MIN_SCALE = 0.75
const OVERLAY_MAX_SCALE = 1.2

const frame = ref<HTMLElement | null>(null)
const mediaScale = ref(1)

const frameResize = new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width ?? OVERLAY_REF_WIDTH
  mediaScale.value = Math.min(
    OVERLAY_MAX_SCALE,
    Math.max(OVERLAY_MIN_SCALE, width / OVERLAY_REF_WIDTH),
  )
})
// the frame is a new element for each item (its :key)
watch(
  frame,
  (el, old) => {
    if (old) frameResize.unobserve(old)
    if (el) frameResize.observe(el)
  },
  { flush: 'post' },
)
onUnmounted(() => frameResize.disconnect())

// Photo fullscreen: the frame fills the screen and the photo is fitted inside
// it, leaving bands when its shape differs. The counter and the pills over it
// go inside the photo, not in them (useContainedInset). A photo turned
// sideways is shown with its sides swapped
const imageAspect = ref<number | null>(null)

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  imageAspect.value = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null
  startPhotoView()
}
watch(
  () => props.entry?.path,
  () => {
    imageAspect.value = null
    stopPhotoView()
  },
)

// ── Counting a photo's view ──
// The same rule as a video's (VideoPlayer.vue): a photo counts as viewed (and
// as "last viewed"), with the "+1" eye, once it has been on screen in the
// viewer for Settings → Most played → "Counts as a view after" seconds (0 =
// as soon as it's shown), once per showing. Only time it's really seen adds
// up: not while the tab is hidden. Dev mode: nothing is counted (src/appMode.ts)

/** Milliseconds the photo has been seen so far, apart from the stretch since `seenSince` */
let seenMs = 0
/** When the running stretch of being seen started (performance.now()); null while it isn't running */
let seenSince: number | null = null
/** Nothing (more) to count for the photo on screen: counted already, not loaded yet, or dev mode */
let photoCounted = true
let photoTimer: ReturnType<typeof setTimeout> | undefined

/** The "+1" eye over the photo (ViewPop.vue): shown once, when the view counts */
const photoPop = ref(false)

function stopPhotoView() {
  clearTimeout(photoTimer)
  seenSince = null
  photoCounted = true
  photoPop.value = false
}

/** The photo has just loaded: its time of being seen starts */
function startPhotoView() {
  stopPhotoView()
  if (!props.entry || !recordsVideoData.value) return
  photoCounted = false
  seenMs = 0
  seenSince = document.hidden ? null : performance.now()
  schedulePhotoView()
}

/** Counts the view when the time needed is up (at once if it already is) */
function schedulePhotoView() {
  clearTimeout(photoTimer)
  if (photoCounted || seenSince === null) return
  const left = settings.viewAfterSeconds * 1000 - seenMs - (performance.now() - seenSince)
  if (left <= 0) countPhotoView()
  else photoTimer = setTimeout(countPhotoView, left)
}

function countPhotoView() {
  clearTimeout(photoTimer)
  if (photoCounted || !props.entry) return
  photoCounted = true
  // switched to dev mode meanwhile: no view, no "+1"
  if (!recordsVideoData.value) return
  emit('viewed', props.entry)
  photoPop.value = true
}

/** The tab was hidden or shown again: the time seen stops and starts with it */
function onVisibilityChange() {
  if (photoCounted) return
  if (document.hidden) {
    if (seenSince !== null) seenMs += performance.now() - seenSince
    seenSince = null
    clearTimeout(photoTimer)
  } else {
    seenSince = performance.now()
    schedulePhotoView()
  }
}

const inset = useContainedInset(frame, () => {
  const a = imageAspect.value
  if (!fullscreen.value || props.entry?.kind !== 'image' || !a) return null
  return sideways.value ? 1 / a : a
})

/** Photo fullscreen: any tap, mouse move or key shows what's over the photo (on a video the player handles its own) */
function onActivity() {
  if (fullscreen.value) showOverlay()
}

function close() {
  if (document.fullscreenElement === root.value) document.exitFullscreen().catch(() => {})
  emit('close')
}

// ── Coming back after a lock (useResume) ──

// photo fullscreen and its turn; the player notes the video's own part
onCaptureResume(() => ({ photoFullscreen: fullscreen.value, rotation: rotation.value }))

/**
 * Handed to the player when the video that was open at the lock opens again:
 * its time, paused or not, fullscreen or not. Null for any other item
 */
const videoResume = ref<ViewerResume | null>(null)

/** Back to photo fullscreen, turned as it was (the unlock's tap still counts as the gesture fullscreen needs) */
function resumePhoto(resume: ViewerResume) {
  if (!resume.photoFullscreen || !canFullscreen) return
  root.value
    ?.requestFullscreen()
    .then(() => (rotation.value = resume.rotation))
    .catch(() => {
      // refused (too long since the tap): the photo stays in the carousel
    })
}

// ── Carousel ──

/** The item now opening was picked by sliding the strip (Scrolling the carousel, below) */
let stripDriven = false

/** Keeps the current item in the middle of the carousel */
watch(
  () => props.entry?.path,
  async (path) => {
    if (!path) return
    // opened by sliding the strip: its thumbnail is already in the middle,
    // and gliding the strip there would fight the finger
    const fromStrip = stripDriven
    stripDriven = false
    // the item open when the app locked: put back how it was shown. Taken
    // before the player is drawn, so it gets its part from the start
    const resume = takeViewerResume(path)
    videoResume.value = resume && props.entry?.kind === 'video' ? resume : null
    // in the carousel each photo starts with what's over it hidden; a video
    // starts with it shown, like its new player's controls (the rule at the top)
    if (!fullscreen.value) hideOverlay()
    videoControlsVisible.value = true
    await nextTick()
    if (resume && props.entry?.kind === 'image') resumePhoto(resume)
    if (fromStrip) return
    strip.value
      ?.querySelector<HTMLElement>(`.thumb[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  },
  { immediate: true },
)

// ── Scrolling the carousel ──
// Like a picker: the thumbnail in the middle of the strip is the one shown,
// and it changes the moment another one reaches the middle while you slide
// it (each passing video starts loading; the one before stops). Only when
// you move the strip (finger, mouse wheel, and its glide after you let go):
// when it glides by itself to an item opened another way (a swipe on the
// photo, keys, a tapped thumbnail), the ones it passes don't open.

/** How long the strip must be still to count as stopped (ms) */
const STRIP_SETTLE_MS = 150

/** The thumbnail in the middle of the strip right now (null: not scrolled yet) */
const centeredPath = ref<string | null>(null)
let settleTimer: ReturnType<typeof setTimeout> | undefined
/** The strip is moving because you moved it (until it stops) */
let userScrolling = false

/** A finger, mouse or wheel on the strip: the scrolling that follows is yours */
function onStripInput() {
  userScrolling = true
}

/** A tapped thumbnail: the strip then glides there by itself */
function onThumbClick(item: Entry) {
  userScrolling = false
  go(item)
}

/** Opens the item whose thumbnail is in the middle, picked by sliding */
function openCentered(path: string) {
  if (path === props.entry?.path) return
  const item = props.entries.find((e) => e.path === path)
  if (!item) return
  stripDriven = true
  go(item)
}

/** The item whose thumbnail is closest to the strip's middle */
function middleThumbPath(): string | null {
  const row = strip.value
  if (!row) return null
  const rect = row.getBoundingClientRect()
  const middle = rect.left + rect.width / 2
  let best: string | null = null
  let bestDistance = Infinity
  for (const el of row.querySelectorAll<HTMLElement>('.thumb')) {
    const r = el.getBoundingClientRect()
    const distance = Math.abs(r.left + r.width / 2 - middle)
    if (distance < bestDistance) {
      bestDistance = distance
      best = el.dataset.path ?? null
    }
  }
  return best
}

function onStripScroll() {
  const path = middleThumbPath()
  if (path !== centeredPath.value) {
    centeredPath.value = path
    // you're sliding it: the one reaching the middle opens right away
    if (userScrolling && path) openCentered(path)
  }
  clearTimeout(settleTimer)
  settleTimer = setTimeout(onStripSettle, STRIP_SETTLE_MS)
}

/** The strip stopped: the next movement is yours again only once you touch it */
function onStripSettle() {
  const path = centeredPath.value
  if (userScrolling && path) openCentered(path)
  userScrolling = false
}

/** Lit up in the strip: the one passing the middle while it moves, else the open one */
function isLit(item: Entry): boolean {
  return item.path === (centeredPath.value ?? props.entry?.path)
}

// a new item opened (swipe, keys, the strip): the strip glides to it, and
// it's the lit one from the start
watch(
  () => props.entry?.path,
  (path) => (centeredPath.value = path ?? null),
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keydown', onActivity)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keydown', onActivity)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearTimeout(settleTimer)
  clearTimeout(photoTimer)
})
</script>

<template>
  <Transition name="fade">
    <div
      v-if="entry"
      ref="root"
      class="lightbox force-glass"
      :class="{
        fullscreen,
        'overlay-off': !overlayShown,
        'overlay-hidden': overlayHidden,
      }"
      @click.self="close"
      @pointermove="onActivity"
      @pointerdown="onActivity"
    >
      <!-- photo fullscreen: the night sky around the photo instead of black -->
      <NightSky v-if="fullscreen" ignore-pause />

      <!-- :key: a new player (or image) for each item, starting fresh -->
      <!-- everything in here over the photo / video shows and hides with its
           controls: the rule at the top of the script -->
      <!-- the colored ring only around hearted ones, like the grid's cards -->
      <div
        :key="entry.path"
        ref="frame"
        class="lightbox-frame ring-frame"
        :class="{ 'plain-ring': !entry.favorite }"
        :style="{
          '--overlay-scale': fullscreen ? 1 : mediaScale,
          '--media-inset-x': `${inset.x.value}px`,
          '--media-inset-y': `${inset.y.value}px`,
        }"
      >
        <!-- which item this is, at the top middle of the photo / video (in
             photo fullscreen: of the screen, counting the photos); on a video
             in the player's colored glass, like its buttons -->
        <p
          v-if="counterText"
          class="media-counter"
          :class="{ 'theme-glass': entry.kind === 'video' }"
        >
          {{ counterText }}
        </p>
        <!-- at the top left: the time left until the app locks and the app
             mode (both in the top bar, which the viewer covers); glass like
             the counter -->
        <div class="media-status">
          <LockTimer class="media-pill" :class="{ 'theme-glass': entry.kind === 'video' }" />
          <AppModeButton class="media-pill" :class="{ 'theme-glass': entry.kind === 'video' }" />
          <!-- a video's resolution, at the top right ("1080p", "4K60"…) -->
          <span
            v-if="entry.kind === 'video' && videoQuality"
            class="media-pill media-quality theme-glass"
            title="Video quality"
            >{{ videoQuality }}</span
          >
        </div>
        <img
          v-if="entry.kind === 'image'"
          :src="fileUrl(entry.path)"
          :alt="entry.name"
          draggable="false"
          :class="{ rotated: fullscreen && rotation !== 0, sideways }"
          :style="fullscreen && rotation !== 0 ? { '--rotation': `${rotation}deg` } : undefined"
          @load="onImageLoad"
          @pointerdown="onSwipeStart"
          @pointerup="onSwipeEnd"
          @pointercancel="onSwipeCancel"
        />
        <!-- the photo was seen long enough to count: the "+1" eye over it
             (inside the photo, past the bands in fullscreen) -->
        <ViewPop v-if="photoPop && entry.kind === 'image'" @done="photoPop = false" />
        <!-- a photo's buttons, in a row at its bottom-right corner (in
             fullscreen: the screen's) -->
        <div v-if="entry.kind === 'image'" class="photo-buttons">
        <!-- fullscreen: turns the photo a quarter clockwise, left of the fullscreen button -->
        <button
          v-if="fullscreen"
          class="round-btn fullscreen-btn rotate-btn"
          aria-label="Rotate"
          title="Rotate (r)"
          @click="rotate"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M15.55 5.55 11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42 1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.48z"
            />
          </svg>
        </button>
        <!-- over the photo's bottom-right corner -->
        <button
          v-if="canFullscreen"
          class="round-btn fullscreen-btn"
          :aria-label="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
          :title="fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'"
          @click="toggleFullscreen"
        >
          <svg v-if="fullscreen" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
          </svg>
        </button>
        </div>
        <VideoPlayer
          v-if="entry.kind === 'video'"
          :src="fileUrl(entry.path)"
          :path="entry.path"
          :poster="thumbUrl(entry.path)"
          :storyboard="storyboardUrl(entry.path)"
          :quality="videoQuality"
          :resume="videoResume"
          :aspect="entry.width && entry.height ? entry.width / entry.height : null"
          @played="emit('viewed', entry)"
          @controls="videoControlsVisible = $event"
        />
      </div>

      <!-- carousel: every photo and video of the folder, under the photo /
           video; the one in its middle is the one shown -->
      <div
        v-if="entries.length > 1"
        ref="strip"
        class="strip"
        @scroll.passive="onStripScroll"
        @pointerdown="onStripInput"
        @touchstart.passive="onStripInput"
        @wheel.passive="onStripInput"
      >
        <button
          v-for="item in entries"
          :key="item.path"
          type="button"
          class="thumb"
          :class="{ current: isLit(item), hearted: item.favorite }"
          :data-path="item.path"
          :title="item.name"
          @click="onThumbClick(item)"
        >
          <img
            :src="item.kind === 'image' ? fileUrl(item.path) : thumbUrl(item.path)"
            :alt="item.name"
            loading="lazy"
            draggable="false"
          />
          <span v-if="item.kind === 'video'" class="thumb-play" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.lightbox {
  /* what the photo / video may fill, leaving room for the carousel (the
     player reads it too: VideoPlayer.vue) */
  --media-max-height: calc(100dvh - 10rem);
  /* the screen's width minus the side padding below (the player's 16:9 box
     can't use 100%: the frame around it is only as wide as its content) */
  --media-max-width: calc(100vw - 4rem);
  position: fixed;
  inset: 0;
  /* the gallery shows faintly through, frosted like the top bar (Settings →
     Look → Viewer background darkness). Always frosted, even with Glass
     effect off (.force-glass, tokens.css): what's behind is paused meanwhile */
  background: rgba(0, 0, 0, var(--lightbox-darkness));
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  backdrop-filter: blur(16px) saturate(140%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 2rem 2rem 1rem;
  box-sizing: border-box;
  cursor: zoom-out;
}

/* ring in the theme colors from styles/ring.css */
.lightbox-frame {
  /* its own ring, independent of the grid's --ring-width (Settings → Look →
     Viewer border). No padding: the ring's colors would show through it as
     a thicker border. Same corners as the photo / player inside, so none
     shows at them either */
  --ring-width: var(--lightbox-ring-width);
  --ring-radius: 6px;
  position: relative; /* for the fullscreen button over the photo */
  display: flex;
  border-radius: 6px;
  max-width: 100%;
  cursor: default;
}

/* the ring fades in / out as the item is hearted / unhearted */
.lightbox-frame::before {
  transition: opacity 0.25s ease;
}

/* not hearted: no colored ring, like the grid's cards (GalleryCard.vue's
   .plain-ring), so the hearted ones stand out here too */
.lightbox-frame.plain-ring::before {
  opacity: 0;
}

.lightbox-frame img {
  max-width: 100%;
  max-height: var(--media-max-height);
  object-fit: contain;
  border-radius: 6px;
  cursor: default;
  /* a sideways swipe goes to the next photo instead of scrolling */
  touch-action: pan-y pinch-zoom;
  user-select: none;
}

/* ── Buttons ── */
.round-btn {
  background: #222;
  border: 1px solid var(--edge);
  box-shadow: var(--edge-shine);
  color: #aaa;
  font-size: 1rem;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    color 0.15s;
}

.round-btn:hover {
  background: #333;
  color: #fff;
}

.round-btn svg {
  width: 1.1rem;
  height: 1.1rem;
  fill: currentColor;
}

/* a photo's buttons (rotate, fullscreen): a row over its
   bottom-right corner */
.photo-buttons {
  position: absolute;
  z-index: 2; /* above the ring */
  right: 0.6rem;
  bottom: 0.6rem;
  display: flex;
  gap: 0.5rem;
}

/* fullscreen: pinned to the screen's bottom-right corner, always on screen */
.lightbox.fullscreen .photo-buttons {
  position: fixed;
  right: 1rem;
  /* above the phone's gesture bar */
  bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
}

/* on the photo: see-through, so it doesn't hide much of it */
.fullscreen-btn {
  width: 2.2rem;
  height: 2.2rem;
  background: rgba(0, 0, 0, 0.45);
  color: #ddd;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.fullscreen-btn:hover {
  background: rgba(0, 0, 0, 0.7);
}

/* turned photo: centered and rotated around its middle. Turned sideways,
   its box gets the screen's height as width and the width as height, so
   once turned it fits the screen exactly as an upright photo would */
.lightbox.fullscreen .lightbox-frame img.rotated {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(var(--rotation));
}

.lightbox.fullscreen .lightbox-frame img.sideways {
  width: 100dvh;
  height: 100dvw;
}

/* ── Counter, and fading the overlay ── */
/* at the top middle of the photo / video, above the player */
.media-counter {
  position: absolute;
  z-index: 5;
  top: calc(0.6rem * var(--overlay-scale, 1));
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  /* the same height as the pills at the top left (.media-pill): their font
     size, line height, padding and 1px rim. It used to be a bigger font with
     the font's own line height, a few px taller. All scale with the media
     (--overlay-scale, set on the frame) */
  padding: calc(0.3rem * var(--overlay-scale, 1)) calc(0.75rem * var(--overlay-scale, 1));
  border-radius: 999px;
  font-size: calc(0.8rem * var(--overlay-scale, 1));
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

/* photo fullscreen: at the top middle of the photo (past the bands a photo of
   another shape leaves: --media-inset-y, set on the frame) */
.lightbox.fullscreen .media-counter {
  position: fixed;
  top: calc(var(--media-inset-y, 0px) + 1rem);
}

/* the lock countdown and the app mode, side by side at the top left of the
   photo / video, and a video's resolution at its top right. The row spans
   the whole top, so it lets taps through itself (to the photo / video under
   it); only the mode takes them */
.media-status {
  position: absolute;
  z-index: 5;
  top: calc(0.6rem * var(--overlay-scale, 1));
  left: calc(0.6rem * var(--overlay-scale, 1));
  right: calc(0.6rem * var(--overlay-scale, 1));
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: calc(0.4rem * var(--overlay-scale, 1));
  /* the pills' height (one line, padding, 1px rim): the mode's image
     (AppModeImage.vue) is a circle this big, so all three line up. Both
     scale with the media (--overlay-scale, set on the frame) */
  --mode-image-size: calc((0.8rem * 1.25 + 0.6rem) * var(--overlay-scale, 1) + 2px);
}

/* both the same pill (the double class wins over AppModeButton.vue's own
   size). The timer lets taps through to the photo / video; the mode is tapped.
   :deep: the mode's pill sits inside AppModeButton (its group is the root),
   where this file's scoped styles don't reach on their own */
.media-status :deep(.media-pill) {
  padding: calc(0.3rem * var(--overlay-scale, 1)) calc(0.65rem * var(--overlay-scale, 1));
  border-radius: 999px;
  font-size: calc(0.8rem * var(--overlay-scale, 1));
  /* set, not the font's own: the image's size above counts on it */
  line-height: 1.25;
}

.media-status :deep(.app-mode-group) {
  pointer-events: auto;
}

/* the resolution: pushed to the right end, a little bolder */
.media-status .media-quality {
  margin-left: auto;
  font-weight: 700;
  letter-spacing: 0.02em;
}

/* small screens: the timer stays top left, the mode and its image go to the
   top right (left of a video's resolution) */
@media (max-width: 600px) {
  .media-status :deep(.app-mode-group) {
    margin-left: auto;
  }

  .media-status .media-quality {
    margin-left: 0;
  }
}

/* photo fullscreen: the top of the photo, inside it (--media-inset-x / -y,
   set on the frame, are the bands a photo of another shape leaves) */
.lightbox.fullscreen .media-status {
  position: fixed;
  top: calc(var(--media-inset-y, 0px) + 1rem);
  left: calc(var(--media-inset-x, 0px) + 1rem);
  right: calc(var(--media-inset-x, 0px) + 1rem);
}

/* the counter, the lock timer and the mode on a photo: dark glass, like the
   photo's buttons */
.media-counter:not(.theme-glass),
.media-status :deep(.media-pill:not(.theme-glass)) {
  background: rgba(0, 0, 0, 0.45);
  /* no rim, but its 1px room kept, so they're as tall as on a video */
  border: 1px solid transparent;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #ddd;
}

/* on a video: .theme-glass (tokens.css) gives the glass, like the player's
   buttons; the text like the player's time pill */
.media-counter.theme-glass,
.media-status :deep(.media-pill.theme-glass) {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

/* everything over the photo / video fades as one, with the player's
   controls (the rule at the top of the script). Something new over the
   photo / video goes in both lists (or inside .media-status). The pills
   fade, not .media-status: a parent's opacity under 1 cuts its children
   off from what's behind, so their glass would lose its blur mid-fade. For
   the same reason the mode's pill and image fade, not their group */
.fullscreen-btn,
.media-counter,
.media-status > :not(.app-mode-group),
.media-status :deep(.app-mode-group > *) {
  transition:
    opacity var(--overlay-fade),
    background 0.15s,
    color 0.15s;
}

/* faded out: can't be clicked either (the tap that brings them back doesn't
   press a button) */
.lightbox.overlay-off .fullscreen-btn,
.lightbox.overlay-off .media-counter,
.lightbox.overlay-off .media-status > :not(.app-mode-group),
.lightbox.overlay-off .media-status :deep(.app-mode-group > *) {
  opacity: 0;
  pointer-events: none;
}

/* the app mode and its image stay, in the carousel and in photo fullscreen,
   even when the rest has faded out (after the rule above, so it wins) */
.lightbox.overlay-off .media-status :deep(.app-mode-group > *) {
  opacity: 1;
  pointer-events: auto;
}

/* When the rest hides, the app mode slides to the nearest edge of the media
   (the left one; on small screens, where it sits on the right, the right
   one) instead of staying where it was, keeping the same breathing space
   from the edge as from the top. The timer and the resolution shrink away to
   nothing, so the mode moves into their room (the carousel and photo
   fullscreen; a video's fullscreen does the same in VideoPlayer.vue) */
.media-status > :not(.app-mode-group) {
  max-width: 10rem;
  overflow: hidden;
  transition:
    opacity var(--overlay-fade),
    max-width var(--overlay-fade),
    padding var(--overlay-fade),
    margin var(--overlay-fade),
    background 0.15s,
    color 0.15s;
}

.lightbox.overlay-off .media-status > :not(.app-mode-group) {
  max-width: 0;
  padding-left: 0;
  padding-right: 0;
  border-left-width: 0;
  border-right-width: 0;
  /* the gap beside it goes too */
  margin-right: calc(-0.4rem * var(--overlay-scale, 1));
}

/* the resolution is last: its gap is on its left (wide screens: the auto
   margin that pushes it right is gone with it, nothing to cancel) */
.lightbox.overlay-off .media-status > .media-quality {
  margin-right: 0;
  margin-left: calc(-0.4rem * var(--overlay-scale, 1));
}

@media (min-width: 601px) {
  .lightbox.overlay-off .media-status > .media-quality {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .media-status > :not(.app-mode-group) {
    transition: none;
  }
}

/* the mouse pointer goes away with them */
.lightbox.overlay-hidden,
.lightbox.overlay-hidden * {
  cursor: none;
}

/* ── Carousel ── */
/* A picker: the thumbnail in the middle is the one shown. As wide as the
   viewer, with half of it (less half a thumbnail) as padding on each side, so
   the first and last thumbnails can reach the middle too; it always comes to
   rest exactly on one (mandatory snap). Fades out toward the ends */
.strip {
  display: flex;
  gap: 0.4rem;
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.8rem;
  padding: 0.3rem calc(50% - 1.75rem);
  overflow-x: auto;
  cursor: default;
  scroll-snap-type: x mandatory;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
}

.thumb {
  position: relative;
  flex: none;
  width: 3.5rem;
  height: 3.5rem;
  padding: 0;
  border: none;
  border-radius: 0.5rem;
  background: #111;
  overflow: hidden;
  cursor: pointer;
  opacity: 0.5;
  scroll-snap-align: center;
  transition: opacity 0.15s;
}

.thumb:hover {
  opacity: 0.85;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* the one on screen: full strength (the others are dimmed). No border of its
   own: the colored one is only for hearted ones (.thumb.hearted) */
.thumb.current {
  opacity: 1;
}

/* hearted: the theme's ring colors (as in styles/ring.css) as a border inside
   its edge, like the hearted photo / video above and the grid's cards. Inside,
   not around it: the thumbnail clips what's outside its corners. A gradient
   cut down to a border: the padding's ring is all that stays of it */
.thumb::after {
  content: '';
  position: absolute;
  inset: 0;
  padding: 2px;
  border-radius: inherit;
  background: conic-gradient(
    from 200deg,
    var(--theme-purple),
    var(--theme-blue),
    var(--theme-cyan),
    var(--theme-green),
    var(--theme-pink),
    var(--theme-purple)
  );
  filter: saturate(var(--ring-vibrancy, 1));
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box exclude,
    linear-gradient(#000 0 0);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}

.thumb.hearted::after {
  opacity: 1;
}

.thumb-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.thumb-play svg {
  width: 1.2rem;
  height: 1.2rem;
  fill: #fff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.7));
}

/* ── Photo fullscreen: the photo fills the screen, the rest steps aside ── */
/* not black around a photo that doesn't fill the screen, but the night sky,
   like the lock screen: the viewer's own NightSky (in the template), behind
   the photo. No darkening or blur: there's nothing of the gallery to frost */
.lightbox.fullscreen {
  --media-max-height: 100dvh;
  padding: 0;
  background: var(--page-bg);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.lightbox.fullscreen .lightbox-frame::before {
  display: none; /* no ring */
}

/* the frame covers the whole screen and the photo is fitted inside it, so no
   photo can come out taller or wider than the screen whatever its shape (in
   the normal flow, some pushed the counter and the button off the screen) */
.lightbox.fullscreen .lightbox-frame {
  position: absolute;
  inset: 0;
  max-width: none;
  border-radius: 0;
}

.lightbox.fullscreen .lightbox-frame img {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  object-fit: contain;
  border-radius: 0;
}

/* only the button at the photo's bottom right leaves fullscreen */
.lightbox.fullscreen .strip {
  display: none;
}

@media (max-width: 600px) {
  .lightbox {
    --media-max-width: calc(100vw - 1rem);
    padding: 3.5rem 0.5rem 0.75rem;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
