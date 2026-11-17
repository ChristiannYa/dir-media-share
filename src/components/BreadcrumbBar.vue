<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppModeButton from '@/components/AppModeButton.vue'
import FolderMenu from '@/components/FolderMenu.vue'
import LockTimer from '@/components/LockTimer.vue'
import { backgroundPaused } from '@/composables/useBackgroundPause'
import { useContextHold } from '@/composables/useContextHold'
import { popupOpen } from '@/composables/usePopupOpen'
import { useScrollHide } from '@/composables/useScrollHide'
import type { Crumb } from '@/types'
import { formatSize } from '@/utils/format'

const props = defineProps<{
  rootName: string
  crumbs: Crumb[]
  /** What the open folder holds directly, and its total size, shown on the third row */
  stats: { videos: number; images: number; folders: number; size: number }
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
}>()

/** The open folder (last crumb); null at the top level */
const current = computed(() => props.crumbs.at(-1) ?? null)

// The open folder's menu has no button: right-click or press-and-hold its name
// (the last crumb) opens it, like on folder cards
const folderMenu = ref<InstanceType<typeof FolderMenu> | null>(null)
const hold = useContextHold(() => folderMenu.value?.open())

function onCrumbClick(crumb: { path: string }, last: boolean) {
  if (last && hold.consumeClick()) return // the press opened the menu
  emit('navigate', crumb.path)
}

// slides away while scrolling down, back while scrolling up; scrolling doesn't
// move it while a dialog or the player is open (they pause the background)
const { hidden } = useScrollHide(() => !backgroundPaused.value)
// while a popup is open (usePopupOpen.ts), both bars slide up off the screen
// whatever the scroll, and come back down when it closes

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
 * the first and last letters to reach it)
 */
function placeLetters(smooth: boolean) {
  const row = strip.value
  const letter = props.alphabet?.current
  if (!row || !letter) return
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

// the bar got wider or narrower: its middle moved
const rowResize = new ResizeObserver(() => placeLetters(false))
watch(strip, (row, old) => {
  if (old) rowResize.unobserve(old)
  if (row) rowResize.observe(row)
})
onUnmounted(() => rowResize.disconnect())
</script>

<template>
  <!-- the top bar and, under it, the alphabet bar: they stick together; while
       scrolling down only the top bar slides away and the alphabet moves up -->
  <header
    class="topbar"
    :class="{ hidden, 'popup-hidden': popupOpen }"
    :style="{ '--nav-height': `${navHeight}px` }"
  >
  <nav ref="navEl" class="breadcrumb glass-bar">
    <!-- Row 1: app buttons (the file order is set in Settings → Sorting) -->
    <div class="actions">
      <!-- time left until the app locks (nothing if it never does) -->
      <LockTimer class="bar-timer theme-glass" />
      <!-- app mode: goon records and shows plays, last viewed and the heatmap; dev neither -->
      <AppModeButton class="theme-glass" />
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
        <!-- the open folder's name: right-click / hold opens its menu -->
        <span
          class="crumb"
          :class="{ 'crumb-current': i === crumbs.length - 1 }"
          :title="i === crumbs.length - 1 ? 'Right-click or hold for folder actions' : undefined"
          v-on="i === crumbs.length - 1 ? hold.listeners : {}"
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

  <!-- its own bar: where you are in the alphabet (only when the folder scrolls) -->
  <div v-if="alphabet" class="alphabet-bar glass-bar">
    <div ref="strip" class="alphabet" aria-hidden="true">
      <span
        v-for="l in alphabet.letters"
        :key="l"
        :data-letter="l"
        class="letter"
        :class="l === alphabet.current ? 'theme-glass current' : 'badge-glass'"
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

/* no sliding: the bars just jump. After the rules above, and listing
   .hidden and .popup-hidden, whose own transitions would win otherwise */
@media (prefers-reduced-motion: reduce) {
  .topbar,
  .topbar.hidden,
  .topbar.popup-hidden {
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

/* hold opens the folder menu: no iOS callout instead */
.crumb-current {
  -webkit-touch-callout: none;
}

/* the lock countdown, first on the left, in the buttons' color */
/* a pill in the same glass as the app mode beside it and the alphabet bar's
   current letter (.theme-glass, tokens.css); amber in the last minute
   (LockTimer.vue's .ending wins over this color) */
.bar-timer {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.8rem;
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
