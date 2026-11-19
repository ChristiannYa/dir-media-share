<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppModeButton from '@/components/AppModeButton.vue'
import AppModeImage from '@/components/AppModeImage.vue'
import CompressButton from '@/components/CompressButton.vue'
import FolderMenu from '@/components/FolderMenu.vue'
import LockTimer from '@/components/LockTimer.vue'
import { backgroundPaused } from '@/composables/useBackgroundPause'
import { compressPulse, compressRequest } from '@/composables/useCompressQueue'
import { popupOpen } from '@/composables/usePopupOpen'
import { useScrollHide } from '@/composables/useScrollHide'
import type { Crumb } from '@/types'
import { ICON_CLOCK, ICON_EYE, ICON_HEART } from '@/icons'
import { formatSize, formatWatched } from '@/utils/format'
import { haptic } from '@/utils/haptics'

const props = defineProps<{
  rootName: string
  crumbs: Crumb[]
  /** What the open folder holds directly, and its total size, shown on the third row */
  stats: {
    videos: number
    images: number
    folders: number
    size: number
    /** hearted videos and photos inside, subfolders included */
    hearts: number
    /** total views of everything inside; null where they aren't recorded */
    views: number | null
    /** total time watched of everything inside (ms); null where it isn't known */
    watchedMs: number | null
  }
  /** The folder's first letters and the one you're at, for the fourth row (null: the page doesn't scroll) */
  alphabet: { letters: string[]; current: string } | null
}>()

const emit = defineEmits<{
  navigate: [path: string]
  settings: []
  shutdown: []
  /** Files or a folder were added to the open folder: reload it */
  changed: []
  /** The open folder was renamed: open it at its new path */
  renamed: [path: string]
  /**
   * The alphabet bar was scrubbed or a letter tapped: scroll the page to that
   * letter (`smooth`: glide there, for a tap; at once while scrubbing)
   */
  letter: [letter: string, smooth: boolean]
}>()

/** Hearts and views aren't shown in .lock itself or the folders directly in it (.bin, src): only deeper (.bin/cinema…) */
const holdsMedia = computed(() => props.crumbs.length >= 2)

/** The open folder (last crumb); null at the top level */
const current = computed(() => props.crumbs.at(-1) ?? null)

// The open folder's menu has no button: clicking its name (the last crumb)
// opens it. Right-click / hold is for the folder cards in the grid only
const folderMenu = ref<InstanceType<typeof FolderMenu> | null>(null)

function onCrumbClick(crumb: { path: string }, last: boolean) {
  if (last) folderMenu.value?.open()
  else emit('navigate', crumb.path)
}

// slides away while scrolling down, back while scrolling up; scrolling doesn't
// move it while a dialog or the player is open (they pause the background)
// While the alphabet bar is scrubbed, the page moving under it leaves the bars
// as they are (the bar under the finger would jump up otherwise)
const { hidden } = useScrollHide(
  () => !backgroundPaused.value,
  () => scrubbing.value,
)
// while a popup is open (usePopupOpen.ts), both bars slide up off the screen
// whatever the scroll, and come back down when it closes

// ── Compress pressed ──
// Pressing Compress (a file's menu, which has the bars slid up, or the
// selection bar) brings both bars into view, faster than usual, and keeps them
// there for a moment (even if the page was scrolled down); once they've slid
// down, the compress indicator pulses (CompressButton.vue)

/** The bars are held in view (.reveal): they slide down quickly, and scrolling doesn't hide them */
const revealing = ref(false)
/** How long the bars are held in view after the slide (ms): the pulse plays meanwhile */
const REVEAL_HOLD_MS = 2500
/** Longest wait for the slide to end, in case it never runs (already in view) (ms) */
const SLIDE_WAIT_MS = 300
const topbarEl = ref<HTMLElement | null>(null)
let revealHold: ReturnType<typeof setTimeout> | undefined
/** Only the latest press goes on to pulse */
let revealRun = 0

/** Resolves once the popup that has the bars slid up is gone (at once if none is open) */
function popupClosed(): Promise<void> {
  if (!popupOpen.value) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(popupOpen, (open) => {
      if (open) return
      stop()
      resolve()
    })
  })
}

/** Resolves when the bars finish sliding, or after SLIDE_WAIT_MS if they had nowhere to slide */
function slideEnded(): Promise<void> {
  return new Promise((resolve) => {
    const el = topbarEl.value
    const done = () => {
      clearTimeout(timer)
      el?.removeEventListener('transitionend', onEnd)
      resolve()
    }
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === 'transform') done()
    }
    const timer = setTimeout(done, SLIDE_WAIT_MS)
    el?.addEventListener('transitionend', onEnd)
  })
}

watch(compressRequest, async () => {
  const run = ++revealRun
  clearTimeout(revealHold)
  revealing.value = true
  await popupClosed()
  await nextTick()
  await slideEnded()
  if (run !== revealRun) return
  compressPulse.value++
  revealHold = setTimeout(() => (revealing.value = false), REVEAL_HOLD_MS)
})
onUnmounted(() => clearTimeout(revealHold))

// the top bar's height: how far the bars move up when it hides, so the
// alphabet bar ends up where the top bar was
const navEl = ref<HTMLElement | null>(null)
const navHeight = ref(0)
const navResize = new ResizeObserver(() => (navHeight.value = navEl.value?.offsetHeight ?? 0))
onMounted(() => navEl.value && navResize.observe(navEl.value))
onUnmounted(() => navResize.disconnect())

const strip = ref<HTMLElement | null>(null)

/**
 * Slides the alphabet row so the current letter sits in its middle, however
 * few letters there are (the row's half-width side padding leaves room for
 * the first and last letters to reach it). Not while you're scrubbing it:
 * your finger moves it then.
 */
function placeLetters(smooth: boolean) {
  const row = strip.value
  const letter = props.alphabet?.current
  if (!row || !letter || scrubbing.value) return
  const el = row.querySelector<HTMLElement>(`[data-letter="${letter}"]`)
  if (!el) return
  row.scrollTo({
    left: el.offsetLeft + el.offsetWidth / 2 - row.clientWidth / 2,
    behavior: smooth ? 'smooth' : 'instant',
  })
}

watch(
  () => [props.alphabet?.current, props.alphabet?.letters.join('')],
  async (_, before) => {
    await nextTick()
    // jump when the row first appears, glide after that
    placeLetters(!!before?.[0])
  },
  { immediate: true },
)

// while scrubbing the bar: a tick of haptics each time the current letter
// changes, so each letter passing the middle is felt (and each one a tapped
// letter's glide goes past). Not while just scrolling the page
watch(
  () => props.alphabet?.current,
  (letter, before) => {
    if (scrubbing.value && letter && before && letter !== before) haptic('tick')
  },
)

// the bar got wider or narrower: its middle moved
const rowResize = new ResizeObserver(() => placeLetters(false))
watch(strip, (row, old) => {
  if (old) rowResize.unobserve(old)
  if (row) rowResize.observe(row)
})
onUnmounted(() => rowResize.disconnect())

// ── Scrubbing the alphabet ──
// Like a picker: slide the row (finger, mouse drag, wheel) and the letter in
// its middle is where the page glides to, letter by letter as they pass.
// Tapping a letter goes there too. Once you let go and both the row and the
// page stop, it settles on the letter the page shows.

/** The row is being moved by you (from the first touch until it and the page stop) */
const scrubbing = ref(false)
/** How long the row and the page must be still, after you let go, to count as stopped (ms) */
const SCRUB_SETTLE_MS = 180
let settleTimer: ReturnType<typeof setTimeout> | undefined
/**
 * A finger or the mouse button is down on the row. A finger is followed by
 * its touch events: its pointer events stop (pointercancel) as soon as the
 * browser takes the touch to slide the row, while the finger is still down
 */
let pressed = false
/** The letter last sent while scrubbing (one jump per letter) */
let lastSent: string | null = null

function startScrub() {
  scrubbing.value = true
  lastSent = props.alphabet?.current ?? null
  clearTimeout(settleTimer)
}

/** Stopped: settles on the page's letter, and page scrolling moves the row again */
function settleSoon() {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    if (pressed) return // still held: waits for the release
    scrubbing.value = false
    lastSent = null
    placeLetters(true)
  }, SCRUB_SETTLE_MS)
}

/** The letter closest to the row's middle */
function middleLetter(): string | null {
  const row = strip.value
  if (!row) return null
  const rect = row.getBoundingClientRect()
  const middle = rect.left + rect.width / 2
  let best: string | null = null
  let bestDistance = Infinity
  for (const el of row.querySelectorAll<HTMLElement>('.letter')) {
    const r = el.getBoundingClientRect()
    const distance = Math.abs(r.left + r.width / 2 - middle)
    if (distance < bestDistance) {
      bestDistance = distance
      best = el.dataset.letter ?? null
    }
  }
  return best
}

// the page still gliding to a letter: not stopped yet (the top bar stays
// put and the row stays where you left it until it arrives)
function onPageScroll() {
  if (scrubbing.value) settleSoon()
}
onMounted(() => window.addEventListener('scroll', onPageScroll, { passive: true }))
onUnmounted(() => window.removeEventListener('scroll', onPageScroll))

/**
 * Sends the page to `letter`: at once while scrubbing, so it keeps up with the
 * finger; `smooth` for a tapped letter. Its haptics come as the current
 * letter changes
 */
function goTo(letter: string, smooth = false) {
  if (letter === lastSent) return
  lastSent = letter
  emit('letter', letter, smooth)
}

function onStripScroll() {
  if (!scrubbing.value) return // moved by the page (placeLetters)
  const letter = middleLetter()
  if (letter) goTo(letter)
  settleSoon()
}

// a finger: down until it lifts, however long it rests (at the last letter,
// say, where the row can't go further) before moving again
function onStripTouchStart() {
  pressed = true
  startScrub()
}

function onStripTouchEnd(e: TouchEvent) {
  if (e.touches.length > 0) return // another finger is still on it
  pressed = false
  settleSoon()
}

// a mouse drags the row (a finger already slides it on its own)
let dragX: number | null = null
let dragged = false

function onStripPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return // a finger: its touch events follow it
  pressed = true
  startScrub()
  dragX = e.clientX
  dragged = false
}

function onStripPointerMove(e: PointerEvent) {
  if (dragX === null || !strip.value) return
  const dx = e.clientX - dragX
  if (!dragged) {
    if (Math.abs(dx) <= 2) return // a click so far, not a drag
    dragged = true
    // only now: captured from the press, the click would miss the letter
    strip.value.setPointerCapture(e.pointerId)
  }
  strip.value.scrollLeft -= dx
  dragX = e.clientX
}

function onStripPointerUp(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return
  pressed = false
  dragX = null
  settleSoon()
}

// a wheel over the row slides it, whichever way it turns (a mouse wheel only
// goes up and down), instead of scrolling the page
function onStripWheel(e: WheelEvent) {
  const row = strip.value
  if (!row) return
  e.preventDefault()
  startScrub()
  row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  settleSoon()
}

/** A tap (not the end of a drag) on a letter goes to it */
function onLetterClick(letter: string) {
  if (dragged) {
    dragged = false
    return
  }
  startScrub()
  goTo(letter, true)
  settleSoon()
}

onUnmounted(() => clearTimeout(settleTimer))
</script>

<template>
  <!-- the top bar and, under it, the alphabet bar: they stick together; while
       scrolling down only the top bar slides away and the alphabet moves up -->
  <header
    ref="topbarEl"
    class="topbar"
    :class="{ hidden, 'popup-hidden': popupOpen, reveal: revealing }"
    :style="{ '--nav-height': `${navHeight}px` }"
  >
  <nav ref="navEl" class="breadcrumb glass-bar">
    <!-- Row 1: app buttons (the file order is set in Settings → Sorting) -->
    <div class="actions">
      <!-- time left until the app locks (nothing if it never does); double-tap to lock -->
      <LockTimer class="bar-timer theme-glass" lockable />
      <!-- app mode: goon records and shows plays, last viewed and the heatmap;
           dev neither. Its image is on the right, by the settings button -->
      <AppModeButton class="theme-glass" no-image />
      <!-- pushes settings and shutdown to the right end -->
      <span class="bar-spacer" />
      <!-- menu of the open folder: no button, opened from its crumb below;
           :key remounts it per folder -->
      <FolderMenu
        v-if="current"
        ref="folderMenu"
        :key="current.path"
        :path="current.path"
        :name="current.name"
        @changed="emit('changed')"
        @renamed="emit('renamed', $event)"
      />
      <!-- the app mode's image: a tap opens the popup that changes it -->
      <AppModeImage editable />
      <!-- the compress queue's progress: only while it lists anything; a tap opens its popup -->
      <CompressButton />
      <button class="bar-btn settings-btn" aria-label="Settings" @click="emit('settings')">
        <!-- gear -->
        <svg viewBox="0 0 24 24" aria-hidden="true" class="filled">
          <path
            d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2.4h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.88a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"
          />
        </svg>
      </button>
      <button class="bar-btn shutdown-btn" aria-label="Shut down the server" @click="emit('shutdown')">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v9" />
          <path d="M6.4 6.6a8 8 0 1 0 11.2 0" />
        </svg>
      </button>
    </div>

    <!-- Row 2: where you are -->
    <div class="crumbs">
      <span class="crumb crumb-home" @click="emit('navigate', '')">{{ rootName }}</span>
      <template v-for="(crumb, i) in crumbs" :key="i">
        <span class="crumb-sep">/</span>
        <!-- the open folder's name: a click opens its menu -->
        <span
          class="crumb"
          :class="{ 'crumb-current': i === crumbs.length - 1 }"
          :title="i === crumbs.length - 1 ? 'Folder actions' : undefined"
          @click="onCrumbClick(crumb, i === crumbs.length - 1)"
          >{{ crumb.name }}</span
        >
      </template>
    </div>

    <!-- Row 3: what this folder holds (not counting inside its subfolders) -->
    <div class="stats">
      <span class="stat" title="Videos in this folder">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"
          />
        </svg>
        {{ stats.videos }}
      </span>
      <span class="stat" title="Images in this folder">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"
          />
        </svg>
        {{ stats.images }}
      </span>
      <span v-if="stats.folders" class="stat" title="Subfolders">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
        </svg>
        {{ stats.folders }}
      </span>
      <!-- only what the folder has, and not in .lock, .bin or src (holdsMedia) -->
      <span
        v-if="holdsMedia && stats.hearts > 0"
        class="stat"
        title="Hearted videos and photos, subfolders included"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_HEART" /></svg>
        {{ stats.hearts }}
      </span>
      <span
        v-if="holdsMedia && stats.views"
        class="stat"
        title="Total views, subfolders included"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
        {{ stats.views }}
      </span>
      <span
        v-if="holdsMedia && stats.watchedMs"
        class="stat"
        title="Total time watched, subfolders included"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_CLOCK" /></svg>
        {{ formatWatched(stats.watchedMs) }}
      </span>
      <span v-if="stats.size" class="stat" title="Total size, subfolders included">
        <!-- hard drive -->
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm13 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5.2 4.6A1 1 0 0 1 6.1 4h11.8a1 1 0 0 1 .9.6L21 11H3l2.2-6.4z"
          />
        </svg>
        {{ formatSize(stats.size) }}
      </span>
    </div>

  </nav>

  <!-- its own bar: where you are in the alphabet (only when the folder scrolls).
       Slide it, or tap a letter, to go to that letter in the folder -->
  <div v-if="alphabet" class="alphabet-bar glass-bar">
    <div
      ref="strip"
      class="alphabet"
      aria-hidden="true"
      @scroll.passive="onStripScroll"
      @pointerdown="onStripPointerDown"
      @pointermove="onStripPointerMove"
      @pointerup="onStripPointerUp"
      @pointercancel="onStripPointerUp"
      @touchstart.passive="onStripTouchStart"
      @touchend.passive="onStripTouchEnd"
      @touchcancel.passive="onStripTouchEnd"
      @wheel="onStripWheel"
    >
      <span
        v-for="l in alphabet.letters"
        :key="l"
        :data-letter="l"
        class="letter"
        :class="l === alphabet.current ? 'theme-glass current' : 'badge-glass'"
        @click="onLetterClick(l)"
        >{{ l }}</span
      >
    </div>
  </div>
  </header>
</template>

<style scoped>
/* Holds the top bar and the alphabet bar, sticking to the top of the screen.
   The gap above it while stuck is the same as the gap between the two bars */
.topbar {
  --bar-gap: 0.5rem;
  position: sticky;
  top: var(--bar-gap);
  z-index: 10;
  /* same gap before scrolling, so the bars don't jump when they start sticking */
  margin-top: var(--bar-gap);
  margin-bottom: 2rem;
  /* coming back: quick, so it's there when you reach for it */
  transition: transform 0.25s ease;
}

/* scrolling down: moved up by the top bar's height and the gap under it, so
   the top bar leaves the screen and the alphabet bar takes its place, with
   the same gap above it. Popups (folder menu, dialogs) are teleported to
   <body>, so the transform doesn't move them */
.topbar.hidden {
  transform: translateY(calc(-1 * (var(--nav-height) + var(--bar-gap))));
  /* hiding: slower and gentler (the transition of the state being entered is used) */
  transition: transform 0.6s ease-in-out;
}

.topbar.hidden .breadcrumb {
  pointer-events: none;
}

/* a popup is open (usePopupOpen.ts): both bars, the top bar and the alphabet
   bar, slide all the way up off the screen: their whole height, the gap
   above them, and room for the shadow. After .hidden, so it wins over it.
   They slide back down (the transition above) once the popup closes */
.topbar.popup-hidden {
  transform: translateY(calc(-100% - var(--bar-gap) - 1rem));
  transition: transform 0.3s ease-in-out;
  pointer-events: none;
}

/* Compress was pressed: held in view, and sliding down fast (0.14 s, the usual
   is 0.25–0.6 s). Only once no popup has them slid up (:not(.popup-hidden)),
   so it also wins over a scroll-hidden bar (.hidden) */
.topbar.reveal:not(.popup-hidden),
.topbar.reveal.hidden:not(.popup-hidden) {
  transform: none;
  transition: transform 0.14s ease-out;
}

.topbar.reveal.hidden:not(.popup-hidden) .breadcrumb {
  pointer-events: auto;
}

/* no sliding: the bars just jump. After the rules above, and listing
   .hidden and .popup-hidden, whose own transitions would win otherwise */
@media (prefers-reduced-motion: reduce) {
  .topbar,
  .topbar.hidden,
  .topbar.popup-hidden,
  .topbar.reveal:not(.popup-hidden),
  .topbar.reveal.hidden:not(.popup-hidden) {
    transition: none;
  }
}


/* Both bars: dark frosted glass, faintly tinted with the background's colors:
   still see-through, darker than the cards' glass so the bar reads clearly.
   How dark: --topbar-darkness (Settings → Look → Top bar darkness; folder
   cards use a share of it); the tint follows --glass-opacity (Glass strength) */
.glass-bar {
  background:
    linear-gradient(
      90deg,
      rgba(255, 0, 64, calc(0.1 * var(--glass-opacity))),
      rgba(90, 60, 255, calc(0.12 * var(--glass-opacity))) 50%,
      rgba(0, 213, 255, calc(0.08 * var(--glass-opacity)))
    ),
    rgba(5, 4, 10, var(--topbar-darkness));
  backdrop-filter: blur(14px) saturate(140%);
  /* same glass edge as the folder cards */
  border: 1px solid var(--edge);
  box-shadow: var(--edge-shine);
  /* several rows: a full pill would be too round */
  border-radius: 1.2rem;
}

/* "Glass effect" off: no blur behind them, so they turn nearly solid to stay readable */
:global(html.no-glass) .glass-bar {
  background: rgba(14, 13, 22, 0.94);
}

.breadcrumb {
  display: flex;
  flex-direction: column;
  padding: 0.4rem 0.6rem;
}

.alphabet-bar {
  margin-top: var(--bar-gap);
  padding: 0.2rem 0.6rem;
}

/* first row: the app buttons */
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.9rem;
  padding: 0.15rem 0.4rem;
}

/* second row, split from the buttons by a faint line; reads as plain text:
   "source / path / to / location" */
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 0.35rem;
  /* the crumbs have no padding of their own: keeps the row lined up with the buttons above */
  padding: 0.35rem 0.4rem 0.05rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

/* third row, split off like the second */
.stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  margin-top: 0.35rem;
  padding: 0.35rem 0.4rem 0.1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  color: #8f88aa;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

/* the alphabet bar's strip of letters, always sliding to keep the current one
   in the middle */
.alphabet {
  position: relative; /* the letters' offsetLeft is measured from here */
  display: flex;
  align-items: center;
  gap: 0.35rem;
  overflow-x: auto;
  /* room above and below for the current letter's scale-up (it's clipped
     otherwise); half the row on each side, so the first and last letters
     can reach the middle */
  padding: 0.55rem 50%;
  /* slid sideways by a finger (the page's own scrolling stays vertical); a
     mouse drags it (BreadcrumbBar's script) */
  touch-action: pan-x;
  cursor: grab;
  scrollbar-width: none;
  /* letters fade out toward the ends */
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent);
}

/* the other letters: small, so the current one stands out */
.letter {
  flex: none;
  display: grid;
  place-items: center;
  min-width: 1rem;
  height: 1rem;
  padding: 0 0.2rem;
  box-sizing: border-box;
  border-radius: 999px;
  color: var(--bar-btn-color);
  font-size: 0.52rem;
  user-select: none;
  transition:
    transform 0.2s,
    color 0.2s;
}

/* bigger than the rest, so it reads at a glance */
.letter.current {
  color: #fff;
  font-weight: 700;
  /* twice the others: about 2rem tall, as before they shrank */
  transform: scale(2);
  /* the scale-up doesn't take space: room so it doesn't cover its neighbors */
  margin-inline: 0.5rem;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.stat svg {
  width: 0.9rem;
  height: 0.9rem;
  fill: currentColor;
}

.crumb {
  cursor: pointer;
  color: #b4aec8;
  transition: color 0.15s;
  white-space: nowrap;
  /* no highlight box or text selection when tapped */
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

/* only with a real pointer: on touch screens hover sticks after a tap */
@media (hover: hover) {
  .crumb:hover {
    color: #fff;
  }
}

.crumb-home {
  color: #f0ecff;
}

.crumb-sep {
  color: rgba(180, 174, 200, 0.35);
  /* a space on each side of the slash */
  padding: 0 0.4em;
  user-select: none;
}

/* the lock countdown, first on the left, in the buttons' color */
/* a pill in the same glass as the app mode beside it and the alphabet bar's
   current letter (.theme-glass, tokens.css); amber in the last minute
   (LockTimer.vue's .ending wins over this color) */
.bar-timer {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.72rem; /* the app mode pill's, so both pills are the same height */
}

/* takes the free space between the left (timer, mode) and right buttons */
.bar-spacer {
  flex: 1;
}

.settings-btn:hover {
  color: #f0ecff;
}

.settings-btn svg.filled {
  width: 1.1rem;
  height: 1.1rem;
  fill: currentColor;
  stroke: none;
}

.bar-btn {
  background: none;
  border: none;
  color: var(--bar-btn-color);
  /* no padding or fixed size: the button is exactly as big as the icon */
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s;
}

.shutdown-btn:hover {
  color: #c0392b;
}

/* power symbol, drawn with strokes so it follows the button's color */
.shutdown-btn svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.4;
  stroke-linecap: round;
}
</style>
