<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import FileMenu from '@/components/FileMenu.vue'
import FolderMenu from '@/components/FolderMenu.vue'
import LoadingDots from '@/components/LoadingDots.vue'
import PreviewVideo from '@/components/PreviewVideo.vue'
import StackBadge from '@/components/StackBadge.vue'
import {
  fileUrl,
  folderPreviewUrl,
  folderThumbUrl,
  previewGeneration,
  previewUrl,
  thumbUrl,
} from '@/api'
import { recordsVideoData } from '@/appMode'
import { TOP_FOLDER_PARENTS, TS_BADGE_TITLE } from '@/constants'
import {
  BADGE_STACK_STATE_KEY,
  BADGE_TARGETS_KEY,
  createBadgeStackState,
} from '@/composables/useBadgeStack'
import { ICON_COMPRESS, ICON_EYE } from '@/icons'
import { settings } from '@/settings'
import { useContextHold } from '@/composables/useContextHold'
import { MEDIA_STATUS_KEY } from '@/composables/useMediaStatus'
import type { Entry } from '@/types'
import { isMediaEntry } from '@/utils/entry'
import { hasPlayed } from '@/utils/firstPlays'
import { formatDuration, formatQuality, formatSize } from '@/utils/format'
import { haptic } from '@/utils/haptics'

const props = defineProps<{
  entry: Entry
  /** Selection mode: a tap picks the file instead of opening it */
  selecting?: boolean
  /** Picked, in selection mode */
  selected?: boolean
  /**
   * Key of its loading / preview state (useMediaStatus); default its path.
   * A second card of the same file (the "Most played" section) gets its own,
   * so the two don't share whether they're on screen
   */
  statusKey?: string
  /**
   * Only a link to the file (the "Most played" section in a folder of
   * videos): no menu (right-click / hold) and no heart; a tap still emits
   * `open`, and the parent decides where it leads
   */
  linkOnly?: boolean
  /**
   * Shows only how many times it was viewed (the "Most played" section): no
   * quality, duration, size, heart or folder counts on the preview
   */
  viewsOnly?: boolean
  /** Just the preview (the "Hearted" section): no badges, heart or status pill on a photo / video */
  bare?: boolean
  /** The app just led you here (App.vue revealCard): it flashes for REVEAL_MS */
  revealing?: boolean
}>()
const emit = defineEmits<{
  open: [entry: Entry]
  /** The card was double-tapped: `on` is the hearted state it should switch to */
  favorite: [entry: Entry, on: boolean]
  /** A file was moved, deleted or uploaded, or a folder renamed: the folder should be reloaded */
  changed: []
}>()

// ── Menu ──
// No ⋮ button: a right-click, or a press-and-hold on touch screens, opens the
// card's menu (the folder menu on folders). Off in selection mode.
const fileMenu = ref<InstanceType<typeof FileMenu> | null>(null)
const folderMenu = ref<InstanceType<typeof FolderMenu> | null>(null)
const hold = useContextHold(
  () => (props.entry.kind === 'folder' ? folderMenu.value : fileMenu.value)?.open(),
  () => !props.selecting && !props.linkOnly,
)

/** A link-only card has no menu: a right-click doesn't open the browser's either */
function onContextMenu(e: MouseEvent) {
  if (props.linkOnly) e.preventDefault()
}

/**
 * Folders show the views of everything inside them, except the ones directly
 * in the shared folder (.bin, src…): those add up nearly everything
 */
const showFolderViews = computed(
  () => recordsVideoData.value && !!props.entry.plays && props.entry.path.includes('/'),
)

/**
 * A compressed copy that wasn't opened yet (server/compressedNew.ts): a
 * "Compressed!" band across the top of its preview until it's opened in the
 * viewer (App.vue). Only on the grid's cards, not the sections' smaller ones
 */
const showCompressedBanner = computed(
  () =>
    !!props.entry.compressed_new &&
    (props.entry.kind === 'video' || props.entry.kind === 'image') &&
    !props.viewsOnly &&
    !props.bare,
)

// ── Badge stack ──
// The badges and pills at the top-left corner (the status pill, "Whole video",
// "Compressed!", the views) are stacked in one column, ordered by priority
// (BADGES in constants.ts): the highest on top, and when one goes away the
// ones under it slide up (StackBadge.vue). The element is in each of the
// card's media boxes (below); PreviewVideo's pills are put in it too.
// While a temporal one (a status, a new copy) is visible, the top-right
// badges (the quality: .corner-badge) are hidden and the stack may use the
// card's whole width (.stack-busy), so nothing is cut off by them
const stackEl = ref<HTMLElement | null>(null)
/** The row at the bottom of the stack: the metadata badges, side by side */
const rowEl = ref<HTMLElement | null>(null)
const stackState = createBadgeStackState()
provide(BADGE_TARGETS_KEY, { stack: stackEl, row: rowEl })
provide(BADGE_STACK_STATE_KEY, stackState)

/** "1 view", "12 views" */
function playsLabel(n: number): string {
  return n === 1 ? '1 view' : `${n} views`
}

// ── Tap: open; double tap: like ──
// Photos and videos have no heart button: a double tap / double click on the
// card hearts it (or un-hearts it), like double-tapping the lock timer
// (LockTimer.vue). So a single tap opens only once no second one came.
// Hearted ones show it by their colored badges. Folders, selection mode and
// link-only cards open (or pick) at once, as before

/** How long after a tap a second one still counts as a double tap (LockTimer.vue's) */
const DOUBLE_TAP_MS = 400
/** A first tap is waiting for a second one; it opens the card when it runs out */
let tapTimer: ReturnType<typeof setTimeout> | undefined

function onClick() {
  if (hold.consumeClick()) return // the press opened the menu
  if (!isMediaEntry(props.entry) || props.selecting || props.linkOnly) {
    emit('open', props.entry)
    return
  }
  if (tapTimer !== undefined) {
    clearTimeout(tapTimer)
    tapTimer = undefined
    toggleFavorite()
    return
  }
  tapTimer = setTimeout(() => {
    tapTimer = undefined
    emit('open', props.entry)
  }, DOUBLE_TAP_MS)
}

onUnmounted(() => clearTimeout(tapTimer))

const media = inject(MEDIA_STATUS_KEY)
if (!media) throw new Error('GalleryCard needs useMediaStatus() provided by a parent')

const {
  vVisible,
  isLoading,
  isThumbLoading,
  hasThumbFailed,
  showPreview,
  isPreviewActive,
  isHeldBack,
  hasPreview,
  onMediaLoad,
  onMediaError,
  onThumbError,
  onPreviewLoaded,
  onPreviewPlaying,
  onPreviewError,
} = media

/** This card's key in the loading / preview state */
const trackKey = computed(() => props.statusKey ?? props.entry.path)

const isMedia = computed(() => isMediaEntry(props.entry))
/**
 * Hearted photos and videos (not in Most played) wear the player's colored
 * glass (.theme-glass) on their badges, the rest the dark one (.badge-glass)
 */
/** A folder directly inside .lock or .bin (TOP_FOLDER_PARENTS): it has its own spacing */
const isTopFolder = computed(() => {
  if (props.entry.kind !== 'folder') return false
  const parent = props.entry.path.split('/').filter(Boolean).at(-2)
  // paths start below the shared folder (.lock itself): no parent = directly in it
  if (parent === undefined) return true
  return TOP_FOLDER_PARENTS.includes(parent.replace(/^\.+/, '').toLowerCase())
})
const coloredBadges = computed(() => isMedia.value && !!props.entry.favorite && !props.viewsOnly)
const badgeGlass = computed(() => (coloredBadges.value ? 'theme-glass' : 'badge-glass'))

/** Videos: "1080p", "4K60"…; null if the size is unknown */
const quality = computed(() =>
  props.entry.kind === 'video'
    ? formatQuality(props.entry.width, props.entry.height, props.entry.fps)
    : null,
)

/**
 * Folders: which of the server's random previews this card shows. Rolled once
 * per card, so each visit to a folder can show a different one, while retries
 * of the same card (e.g. after it was built) keep asking for the same one.
 */
const folderPick = Math.floor(Math.random() * 1_000_000)

/** Length of the "like" burst over the preview (keep in sync with the animations below) */
const POP_MS = 1200
/** How many dots fly out of the burst */
const LIKE_DOTS = 12
/** Just hearted by a double tap: a big heart pops in the middle of the preview, with its burst */
const popping = ref(false)
/** Just un-hearted: the heart shows empty in the middle and fades away */
const unliking = ref(false)
let popTimer: ReturnType<typeof setTimeout> | undefined

function toggleFavorite() {
  const on = !props.entry.favorite
  clearTimeout(popTimer)
  popping.value = on
  unliking.value = !on
  popTimer = setTimeout(() => {
    popping.value = false
    unliking.value = false
  }, POP_MS)
  haptic('tap')
  emit('favorite', props.entry, on)
}

onUnmounted(() => clearTimeout(popTimer))

// ── Shape ──
// Landscape (and square) photos and videos get a square card, cropped to
// fill it. Portrait ones get their own shape, as tall as they need, so
// nothing is cut off. Videos' shape comes with the listing; photos' only
// once they load (the server doesn't measure them), so a portrait photo's
// card starts square and grows when it arrives.

/** Tallest a card gets: a narrower shape than this (1 wide : 3 tall) is still cropped */
const MIN_CARD_RATIO = 1 / 3

/** A photo's width / height, once it has loaded */
const loadedRatio = ref<number | null>(null)

/** The media box's width / height: 1 (square) unless the media is portrait */
const mediaRatio = computed(() => {
  const { width, height } = props.entry
  const ratio = width && height ? width / height : loadedRatio.value
  if (!ratio || ratio >= 1) return 1
  return Math.max(ratio, MIN_CARD_RATIO)
})

// ── Masonry (App.vue's .grid) ──
// The grid's rows are 1px tall: the card spans as many as it is tall, plus
// the gap under it (the same as the gap between columns), so each column
// stacks its cards with no holes. Measured again whenever the card's height
// changes (a photo loading, columns changing, a font change…)

const cardEl = ref<HTMLElement | null>(null)
/** Rows (px) the card takes in the grid; null until measured */
const rowSpan = ref<number | null>(null)

function measureSpan() {
  const el = cardEl.value
  const grid = el?.parentElement
  if (!el || !grid) return
  let gap = parseFloat(getComputedStyle(grid).columnGap) || 0
  // a folder's own side margins (Space between folders) count under it too
  if (props.entry.kind === 'folder') gap += 2 * (parseFloat(getComputedStyle(el).marginLeft) || 0)
  gap = Math.max(0, gap)
  // offsetHeight: its height in the layout, unaffected by the hover lift or
  // the selection's shrink (transforms)
  rowSpan.value = Math.max(1, Math.ceil(el.offsetHeight + gap))
}

const sizeObserver = new ResizeObserver(measureSpan)
onMounted(() => {
  if (cardEl.value) sizeObserver.observe(cardEl.value)
  measureSpan()
})
onUnmounted(() => sizeObserver.disconnect())
// a new gap (Settings) doesn't resize the card itself: measure again
watch(
  () => [settings.gridGap, settings.folderGap, settings.topFolderGap, settings.previewExtraHeight],
  () => nextTick(measureSpan),
)

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight)
    loadedRatio.value = img.naturalWidth / img.naturalHeight
  onMediaLoad(trackKey.value)
}

/**
 * The card's preview plays for the first time since the page loaded: it
 * starts blurred, and a see-through layer slides down through it once (only
 * the preview: not the name under it), revealing it sharp above its bottom
 * edge. In two steps, so the preview is never seen sharp before the sweep:
 *  1. waiting (prepareSweep): the clip is downloaded and this card hasn't
 *     revealed it yet (firstPlayAhead), the video still hidden. The sweep is
 *     put in place, standing still: its frost already covers the preview,
 *     its colors above it
 *  2. running (runSweep): this card's video starts playing (behind the
 *     frost), and the sweep slides down. Or, if the card is on screen but
 *     its preview is held back (Max playing previews: it won't play for
 *     now), right away: it reveals the sharp still instead, rather than
 *     leaving it blurred with the clip ready
 * All decided by this card, from its own preview's events: not by the
 * page-wide first-play check (utils/firstPlays.ts), which a second card of
 * the same file or folder (the "Most played" section and the grid) would
 * never pass, leaving it blurred
 * Its colors are always the five theme colors, laid out at random each time
 * (the .preview-sweep style): a soft blob of each at a random spot, size and
 * shape, fading into the others, over a blend of them all at a random angle
 * and order, so the whole layer is colored. Null while there's no sweep
 */
const SWEEP_COLORS = ['purple', 'blue', 'cyan', 'green', 'pink'].map((c) => `var(--theme-${c})`)
const sweepStyle = ref<Record<string, string> | null>(null)
/** The sweep stands still, its frost over the preview, until the video plays */
const sweepWaiting = ref(false)

/** The colors in a random order (Fisher–Yates) */
function shuffledColors(): string[] {
  const order = [...SWEEP_COLORS]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** A whole number from `min` to `max` */
function randomIn(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min))
}

/** Step 1: the sweep in place, still, its frost over the (still hidden) preview */
function prepareSweep() {
  // a blob of each color: an ellipse 45–95% of the preview wide and tall,
  // centered anywhere on it, fading out to its edge
  const blobs = shuffledColors().map(
    (color) =>
      `radial-gradient(ellipse ${randomIn(45, 95)}% ${randomIn(45, 95)}% at ` +
      `${randomIn(0, 100)}% ${randomIn(0, 100)}%, ${color}, transparent)`,
  )
  // under them, every color blended at a random angle: no spot is left empty
  const base = `linear-gradient(${randomIn(0, 359)}deg, ${shuffledColors().join(', ')})`
  sweepStyle.value = { '--sweep-colors': [...blobs, base].join(', ') }
  sweepWaiting.value = true
}

/**
 * Step 2: the sweep slides down and reveals the preview (or the still).
 * Only once per card: nothing to reveal once it's done, or for a card whose
 * preview had already played when it appeared
 */
function runSweep() {
  if (!firstPlayAhead.value && !sweepWaiting.value) return
  if (!sweepStyle.value) prepareSweep() // played without step 1: its colors now
  sweepWaiting.value = false
  firstPlayAhead.value = false
}

/** Its clip is downloaded (still hidden): step 1, if it's still to be revealed */
function onOwnPreviewLoaded() {
  onPreviewLoaded(trackKey.value)
  if (firstPlayAhead.value) prepareSweep()
}

/** Its video started playing: step 2 (does nothing if already revealed) */
function onOwnPreviewPlaying() {
  onPreviewPlaying(trackKey.value)
  runSweep()
}

// the clip is ready, the card on screen, but its preview is held back (Max
// playing previews): reveal the still now rather than keep it blurred until
// it gets a turn to play (it then just plays, sharp)
watch(
  () => sweepWaiting.value && isHeldBack(trackKey.value),
  (heldBack) => {
    if (heldBack) runSweep()
  },
)

/** The sweep is gone (done, or its preview went away or failed) */
function endSweep() {
  sweepStyle.value = null
  sweepWaiting.value = false
}

/**
 * A video card, or a folder card with a preview, whose preview hasn't played
 * yet since the page loaded: its still (a folder's: .folder-still) is shown
 * blurred, low quality, from the start (while the server is asked, encodes,
 * the clip downloads…), and stays so until the sweep reveals the preview.
 * Then false for good; also when the preview fails, so the still isn't left
 * blurred with nothing coming to reveal it. At the start: true unless its
 * preview already played since the page loaded (same key as PreviewVideo's
 * first-play check, "video:path" / "folder:path"); after that, only this
 * card's own events change it
 */
const previewKind =
  props.entry.kind === 'video' || props.entry.kind === 'folder' ? props.entry.kind : null
const firstPlayAhead = ref(
  previewKind !== null &&
    hasPreview(props.entry) &&
    !hasPlayed(`${previewKind}:${props.entry.path}`),
)

/** Folders: their preview's still loaded (shown over the icon), or failed (the icon stays) */
const folderStillLoaded = ref(false)
const folderStillFailed = ref(false)

/** The still's blur (.thumb-veil), until a sweep (with its own frost) takes over */
const thumbVeiled = computed(() => firstPlayAhead.value && !sweepStyle.value)

/** The preview failed: no sweep is coming, the still shows sharp */
function onPreviewFailed() {
  onPreviewError(trackKey.value)
  endSweep()
  firstPlayAhead.value = false
}

// the preview went away before playing (scrolled far off, folder left…): a
// waiting sweep would leave the still blurred behind it
watch(
  () => showPreview(trackKey.value),
  (shown) => {
    if (!shown) endSweep()
  },
)

/**
 * The app led you to this card (App.vue revealCard): it plays the same sweep
 * as a preview that just loaded, once, at once (not waiting for a video to
 * play). Restarted from scratch if it's already running
 */
watch(
  () => props.revealing,
  async (on) => {
    if (!on) return
    endSweep()
    await nextTick()
    prepareSweep()
    sweepWaiting.value = false
  },
)
</script>

<template>
  <div
    ref="cardEl"
    class="card"
    :data-path="entry.path"
    :style="rowSpan ? { gridRowEnd: `span ${rowSpan}` } : undefined"
    :class="[
      entry.kind,
      {
        'ring-frame': isMedia,
        'ring-loading': isMedia && isLoading(entry, trackKey),
        // hearted photos and videos show their ring (theme colors); the rest get the glass
        // border instead. Not in the Most played section (viewsOnly): there every one gets the glass
        // No colored ring on any card (grid, Hearted section): a hearted one's
        // badges wear the player's colored glass instead (.colored-badges).
        // Not in Most played (viewsOnly): there every card is plain
        'plain-ring': isMedia,
        'colored-badges': coloredBadges,
        'top-folder': isTopFolder,
        'has-preview': entry.kind === 'folder' && hasPreview(entry),
        'is-loading': isLoading(entry, trackKey),
        selecting,
        selected,
        'link-only': linkOnly,
        'views-only': viewsOnly,
        'stack-busy': stackState.temporal > 0,
      },
    ]"
    v-on="hold.listeners"
    @contextmenu="onContextMenu"
    @click="onClick"
  >
    <!-- selection mode: a faint blue layer over picked files -->
    <span v-if="selecting && selected" class="select-tint" aria-hidden="true" />
    <!-- selection mode: files get a check circle (their menu can't be opened meanwhile) -->
    <span
      v-if="selecting && entry.kind !== 'folder'"
      class="check"
      :class="{ on: selected }"
      aria-hidden="true"
    >
      <svg v-if="selected" viewBox="0 0 24 24">
        <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
      </svg>
    </span>
    <LoadingDots
      v-if="isLoading(entry, trackKey) && settings.loadingDots > 0"
      :count="settings.loadingDots"
    />

    <!-- Folder -->
    <!-- Folder: icon, with a preview of what's inside on top once it plays -->
    <!-- .no-preview: nothing to preview inside, so the info is plain text on the glass -->
    <div
      v-if="entry.kind === 'folder'"
      v-visible="trackKey"
      class="folder-wrap"
      :class="{ 'no-preview': !hasPreview(entry), 'with-name': !viewsOnly && hasPreview(entry) }"
    >
      <span class="folder-icon">📁</span>
      <!-- the still of the preview this card will play (its first video /
           image, the same pick), over the icon once it loads: blurred
           (thumbVeiled) until the preview plays and the sweep reveals it.
           Answered right away, even while the clip is being built -->
      <img
        v-if="hasPreview(entry) && !folderStillFailed"
        class="folder-still"
        :class="{ loaded: folderStillLoaded }"
        :src="folderThumbUrl(entry.path, folderPick)"
        alt=""
        loading="lazy"
        @load="folderStillLoaded = true"
        @error="folderStillFailed = true"
      />
      <!-- :key: reloads with clips made with the new settings after they change -->
      <PreviewVideo
        v-if="hasPreview(entry) && showPreview(trackKey)"
        :key="previewGeneration"
        kind="folder"
        :path="entry.path"
        :active="isPreviewActive(trackKey)"
        :api-url="folderPreviewUrl(entry.path, folderPick)"
        @loaded="onOwnPreviewLoaded"
        @playing="onOwnPreviewPlaying"
        @error="onPreviewFailed"
      />
      <!-- top-left: the preview's status pill (put here by PreviewVideo) -->
      <div ref="stackEl" class="badge-stack">
        <!-- the compressed copies not opened yet directly inside this folder (not
             in its subfolders: the count is on the folder that holds them) -->
        <StackBadge badge="compressedFolder" :show="!!entry.compressed_new_count && !viewsOnly">
          <span
            class="info-badge compressed-badge"
            :title="`${entry.compressed_new_count} compressed ${entry.compressed_new_count === 1 ? 'copy' : 'copies'} not opened yet in this folder`"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_COMPRESS" /></svg>
            {{ entry.compressed_new_count }}
          </span>
        </StackBadge>
        <div ref="rowEl" class="badge-row" />
      </div>
      <!-- its preview hasn't played yet: the still shows blurred, low
           quality, until the sweep below takes over and reveals the preview
           (thumbVeiled). Blurred even with Glass effect off (.force-glass) -->
      <span v-if="thumbVeiled" class="thumb-veil force-glass" aria-hidden="true" />
      <!-- its preview's first play: blurred (the frost) from before the video
           shows, then colors slide down through it, the sharp preview
           showing above them as they pass (prepareSweep / runSweep) -->
      <div
        v-if="sweepStyle"
        class="preview-sweep"
        :class="{ waiting: sweepWaiting }"
        :style="sweepStyle"
        aria-hidden="true"
        @animationend.self="endSweep"
      >
        <span class="sweep-colors" />
        <!-- .force-glass: blurred even with Glass effect off (tokens.css):
             it's what makes the preview start out low quality, and only
             lasts the sweep -->
        <span class="sweep-frost force-glass" />
      </div>
      <!-- its dates (last added, last viewed) are in its menu (right-click / hold) -->
      <!-- bottom row: what's inside and its size, on the right -->
      <!-- not there at all when the folder has nothing to count (empty, or only empty subfolders) -->
      <div
        v-if="
          viewsOnly
            ? showFolderViews
            : entry.video_count || entry.image_count || showFolderViews || entry.size
        "
        class="folder-badges"
      >
        <!-- videos / images inside (subfolders included), views and total size; zero
             counts are hidden. viewsOnly: just the views -->
        <span class="badge-glass folder-badge folder-contents">
          <span v-if="entry.video_count && !viewsOnly" class="count" title="Videos">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"
              />
            </svg>
            {{ entry.video_count }}
          </span>
          <span v-if="entry.image_count && !viewsOnly" class="count" title="Images">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"
              />
            </svg>
            {{ entry.image_count }}
          </span>
          <!-- slides open / shut when the app mode switches -->
          <Transition name="mode-count">
            <span
              v-if="showFolderViews"
              class="count"
              :title="`${playsLabel(entry.plays ?? 0)} of what's inside, on every device`"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
              {{ entry.plays }}
            </span>
          </Transition>
          <span v-if="entry.size && !viewsOnly" class="count" title="Total size">
            <!-- hard drive -->
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm13 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5.2 4.6A1 1 0 0 1 6.1 4h11.8a1 1 0 0 1 .9.6L21 11H3l2.2-6.4z"
              />
            </svg>
            {{ formatSize(entry.size) }}
          </span>
        </span>
      </div>
      <!-- the name, on the bottom of the preview over a band of blur (.force-glass:
           blurred even with Glass effect off). No name in the "Most played"
           section: only the views there -->
      <p v-if="!viewsOnly" class="label folder-name force-glass" :title="entry.name">
        <span class="name">{{ entry.name }}</span>
      </p>
    </div>

    <!-- Image -->
    <div v-else-if="entry.kind === 'image'" class="media-wrap" :style="{ aspectRatio: mediaRatio }">
      <div v-if="isThumbLoading(trackKey)" class="placeholder" />
      <img
        :src="fileUrl(entry.path)"
        loading="lazy"
        :alt="entry.name"
        @load="onImageLoad"
        @error="onMediaError(trackKey)"
      />
      <!-- top-left: a compressed copy not opened yet -->
      <div ref="stackEl" class="badge-stack">
        <StackBadge badge="compressed" :show="showCompressedBanner">
          <span class="info-badge compressed-badge">Compressed!</span>
        </StackBadge>
        <div ref="rowEl" class="badge-row" />
        <!-- how many times it was shown in the viewer, like a video's (in the
             metadata row; not in selection mode: the check is there) -->
        <StackBadge
          v-if="!viewsOnly"
          badge="plays"
          :show="!selecting && recordsVideoData && !bare"
        >
          <span
            class="info-badge plays-badge"
            :class="badgeGlass"
            :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
            {{ entry.plays ?? 0 }}
          </span>
        </StackBadge>
      </div>
      <!-- the app led you here: the loaded sweep, once (see the script) -->
      <div
        v-if="sweepStyle"
        class="preview-sweep"
        :style="sweepStyle"
        aria-hidden="true"
        @animationend.self="endSweep"
      >
        <span class="sweep-colors" />
        <span class="sweep-frost force-glass" />
      </div>
      <!-- viewsOnly: just how many times it was shown, bottom-right like a folder's -->
      <span
        v-if="viewsOnly && !bare"
        class="info-badge plays-badge views-only"
        :class="badgeGlass"
        :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
        {{ entry.plays ?? 0 }}
      </span>
      <!-- double tap: a big heart in the middle (see the script) -->
      <span
        v-if="popping || unliking"
        class="like-pop"
        :class="{ on: popping, pop: popping, unlike: unliking }"
        aria-hidden="true"
      >
        <span class="heart" />
        <!-- "like" burst: a ring swells and empties, dots fly out, the heart pops in -->
        <span v-if="popping" class="burst">
          <span class="like-glow" />
          <span class="ring" />
          <span class="ring ring-late" />
          <span
            v-for="i in LIKE_DOTS"
            :key="i"
            class="dot"
            :style="{ '--angle': `${(i * 360) / LIKE_DOTS}deg` }"
          />
        </span>
      </span>
      <div v-if="!viewsOnly && !bare" class="video-badges">
        <span v-if="entry.size" class="info-badge size-badge" :class="badgeGlass" title="File size">
          <!-- hard drive -->
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm13 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5.2 4.6A1 1 0 0 1 6.1 4h11.8a1 1 0 0 1 .9.6L21 11H3l2.2-6.4z"
            />
          </svg>
          {{ formatSize(entry.size) }}
        </span>
      </div>
      <!-- its dates (added, last viewed) are in its menu (right-click / hold) -->
    </div>

    <!-- Video: still frame, with the auto-playing preview on top once it plays -->
    <div
      v-else-if="entry.kind === 'video'"
      v-visible="trackKey"
      class="media-wrap video-wrap"
      :style="{ '--media-ratio': mediaRatio }"
    >
      <div v-if="isThumbLoading(trackKey)" class="placeholder" />
      <div v-if="hasThumbFailed(trackKey)" class="thumb-failed">⚠</div>
      <img
        v-else
        :src="thumbUrl(entry.path)"
        loading="lazy"
        :alt="entry.name"
        @load="onMediaLoad(trackKey)"
        @error="onThumbError(trackKey)"
      />
      <PreviewVideo
        v-if="showPreview(trackKey)"
        :key="previewGeneration"
        kind="video"
        :bare="bare"
        :path="entry.path"
        :active="isPreviewActive(trackKey)"
        :api-url="previewUrl(entry.path)"
        @loaded="onOwnPreviewLoaded"
        @playing="onOwnPreviewPlaying"
        @error="onPreviewFailed"
      />
      <!-- its preview hasn't played yet: the still shows blurred, low
           quality, until the sweep below takes over and reveals the preview
           (thumbVeiled). Blurred even with Glass effect off (.force-glass) -->
      <span v-if="thumbVeiled" class="thumb-veil force-glass" aria-hidden="true" />
      <!-- its preview's first play: blurred (the frost) from before the video
           shows, then colors slide down through it, the sharp preview
           showing above them as they pass (prepareSweep / runSweep) -->
      <div
        v-if="sweepStyle"
        class="preview-sweep"
        :class="{ waiting: sweepWaiting }"
        :style="sweepStyle"
        aria-hidden="true"
        @animationend.self="endSweep"
      >
        <span class="sweep-colors" />
        <!-- .force-glass: blurred even with Glass effect off (tokens.css):
             it's what makes the preview start out low quality, and only
             lasts the sweep -->
        <span class="sweep-frost force-glass" />
      </div>
      <!-- top-left, stacked by priority (BADGES): the preview's status pill
           (put here by PreviewVideo), then "Compressed!" for a copy not opened
           yet, then a row of the metadata: how many times it was played (not
           in selection mode: the check is there) and the icon PreviewVideo
           adds when its preview is the whole video. Each slides away when it
           goes, and the ones under / after it slide up / along. Switching the
           app mode opens / closes the views. StackBadge puts each in the column
           or the row by its kind, wherever it's written -->
      <div ref="stackEl" class="badge-stack">
        <StackBadge badge="compressed" :show="showCompressedBanner">
          <span class="info-badge compressed-badge">Compressed!</span>
        </StackBadge>
        <div ref="rowEl" class="badge-row" />
        <StackBadge
          v-if="!viewsOnly"
          badge="plays"
          :show="!selecting && recordsVideoData && !bare"
        >
          <span
            class="info-badge plays-badge"
            :class="badgeGlass"
            :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
            {{ entry.plays ?? 0 }}
          </span>
        </StackBadge>
      </div>
      <!-- viewsOnly (the "Most played" section): just the views, bottom-right,
           where the folder cards have theirs. Pops in / out like the app mode switches -->
      <Transition name="mode-badge">
        <span
          v-if="viewsOnly && !selecting && recordsVideoData && !bare"
          class="info-badge plays-badge views-only"
          :class="badgeGlass"
          :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
          {{ entry.plays ?? 0 }}
        </span>
      </Transition>
      <!-- top-right: the quality -->
      <span
        v-if="quality && !viewsOnly && !bare"
        class="info-badge quality-badge corner-badge"
        :class="badgeGlass"
      >
        {{ quality }}
      </span>
      <!-- double tap: a big heart in the middle (see the script) -->
      <span
        v-if="popping || unliking"
        class="like-pop"
        :class="{ on: popping, pop: popping, unlike: unliking }"
        aria-hidden="true"
      >
        <span class="heart" />
        <span v-if="popping" class="burst">
          <span class="like-glow" />
          <span class="ring" />
          <span class="ring ring-late" />
          <span
            v-for="i in LIKE_DOTS"
            :key="i"
            class="dot"
            :style="{ '--angle': `${(i * 360) / LIKE_DOTS}deg` }"
          />
        </span>
      </span>
      <div v-if="!viewsOnly && !bare" class="video-badges">
        <!-- bottom-left: the TS warning -->
        <span v-if="entry.needs_fix" class="ts-badge" :title="TS_BADGE_TITLE">TS</span>
        <span
          v-if="entry.duration"
          class="info-badge duration-badge"
          :class="badgeGlass"
          title="Duration"
        >
          <!-- clock -->
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"
            />
          </svg>
          {{ formatDuration(entry.duration) }}
        </span>
        <span v-if="entry.size" class="info-badge size-badge" :class="badgeGlass" title="File size">
          <!-- hard drive -->
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm13 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5.2 4.6A1 1 0 0 1 6.1 4h11.8a1 1 0 0 1 .9.6L21 11H3l2.2-6.4z"
            />
          </svg>
          {{ formatSize(entry.size) }}
        </span>
      </div>
      <!-- its dates (added, last viewed) are in its menu (right-click / hold) -->
    </div>

    <!-- File fallback -->
    <div v-else class="folder-wrap">
      <span class="folder-icon">📄</span>
    </div>

    <!-- a file's name, under it (a folder's is inside its preview) -->
    <p v-if="!isMedia && entry.kind !== 'folder' && !viewsOnly" class="label" :title="entry.name">
      <span class="name">{{ entry.name }}</span>
    </p>

    <!-- the card's menu: no button, opened by `hold` (its popups are teleported to <body>);
         a renamed subfolder just reloads this listing -->
    <FolderMenu
      v-if="entry.kind === 'folder' && !linkOnly"
      ref="folderMenu"
      :key="entry.path"
      :path="entry.path"
      :name="entry.name"
      :last-added="entry.last_added"
      :last-viewed="entry.last_viewed"
      with-dates
      @changed="emit('changed')"
      @renamed="emit('changed')"
    />
    <FileMenu v-else-if="!linkOnly" ref="fileMenu" :entry="entry" @changed="emit('changed')" />
  </div>
</template>

<style scoped>
/* ── Card ── */
.card {
  /* corners: one value for folders, one for videos and photos (Settings →
     Look → Folder corners, Video corners); everything inside follows it */
  --card-radius: var(--video-radius);
  position: relative; /* anchors the loading dots */
  background: #1a1a1a;
  border-radius: var(--card-radius);
  overflow: hidden;
  cursor: pointer;
  /* a double tap hearts it (the script): no double-tap zoom of the page */
  touch-action: manipulation;
  border: var(--card-border) solid var(--edge);
  transition:
    transform 0.15s,
    border-color 0.15s,
    box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  /* press-and-hold opens the card's menu: no iOS image callout or text selection instead */
  -webkit-touch-callout: none;
  user-select: none;
}

/* lifts a little, with a brighter edge; no dark shadow under it */
.card:hover {
  transform: translateY(-3px);
  border-color: var(--edge-strong);
}

/* Ring in the theme colors (styles/ring.css); while loading, an arc sweeps around it */
.card.image,
.card.video {
  --ring-radius: var(--card-radius);
  --ring-inset: var(--card-border);
  overflow: visible;
  border-color: transparent;
}

.card.image:hover,
.card.video:hover {
  /* the card stays put: only the preview inside zooms (.media-wrap, Media below) */
  transform: none;
  border-color: transparent;
  /* the ring's theme colors at full strength */
  --ring-mix: 100%;
}

/* Photos and videos that aren't hearted: no ring (they get the glass border
   instead), so the hearted ones (theme colors) stand out. It's only
   see-through rather than gone, so hearting one doesn't shift it, and the
   loading sweep still runs where the ring would be */
.card.plain-ring,
.card.plain-ring:hover {
  --ring-rest: linear-gradient(transparent, transparent);
}

/* ── Glass border ──
   Folder cards, and photo and video cards that aren't hearted, get a frosted
   glass frame around them, outside the card's edge (and outside the ring's
   place on photos and videos; hearted ones show the ring instead), so the sky blends
   into it, blurred. The same glass as the badges (.badge-glass, tokens.css:
   Badge darkness, Badge glass ratio); thickness --card-glass-width (Settings →
   Look → Glass border width). A mask cuts out the middle, so only the frame
   is drawn and the video itself stays untouched */
/* The ring and the glass border are drawn INSIDE the card, over the edge of the
   preview, so they never take room from the grid's spacing */
.card.ring-frame::before {
  inset: 0;
  padding: var(--ring-width);
  border-radius: max(0px, calc(var(--card-radius) - var(--card-border)));
  z-index: 4;
  pointer-events: none;
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box exclude,
    linear-gradient(#000 0 0);
}

/* folders, and the photos and videos that aren't hearted (.plain-ring): the
   hearted ones get the colored ring instead, so they stand out */
.card.folder::after,
.card.plain-ring::after {
  content: '';
  position: absolute;
  z-index: 3;
  inset: 0;
  padding: var(--card-glass-width);
  /* parallel to the card's corners */
  border-radius: max(0px, calc(var(--card-radius) - var(--card-border)));
  background:
    linear-gradient(
      145deg,
      rgba(255, 255, 255, calc(0.09 * var(--glass-opacity) * var(--badge-glass-ratio))),
      rgba(255, 255, 255, calc(0.025 * var(--glass-opacity) * var(--badge-glass-ratio)))
    ),
    rgba(5, 4, 10, var(--badge-darkness));
  -webkit-backdrop-filter: blur(10px) saturate(150%);
  backdrop-filter: blur(10px) saturate(150%);
  /* the glass rim on its outer edge */
  box-shadow: inset 0 0 0 1px var(--edge);
  /* only the frame: the padding is kept, the inside (the card) cut out */
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box exclude,
    linear-gradient(#000 0 0);
  pointer-events: none;
}

/* ── Preview sweep ──
   A preview's first play since the page loaded (prepareSweep / runSweep in
   the script). It starts out low quality, blurred, and a see-through layer of
   the five theme colors (randomly laid out: --sweep-colors) slides down
   through it once, from above it to below it; above the colors' bottom edge
   the sharp preview shows, below it the blur stays, until it's all revealed.

   One piece, twice the preview's height, moving down by its own height:
   the colors in its top half, the frost (the blur) in its bottom half, right
   under them. At the start the colors are above the preview and the frost
   covers it; at the end the colors are below it and the frost far below, so
   the reveal edge is always exactly the colors' bottom edge.

   Inside the preview's box (.folder-wrap / .media-wrap), which clips it, so
   the name under it is left alone; after the preview, before the badges, so
   it passes over the picture and under the badges. The piece itself only
   moves (a transform): an opacity, mask or filter on it would cut the
   frost's blur off from the preview under it */
.preview-sweep {
  position: absolute;
  top: -100%;
  left: 0;
  width: 100%;
  height: 200%;
  pointer-events: none;
  animation: preview-sweep 1.4s ease-in-out forwards;
}

@keyframes preview-sweep {
  to {
    transform: translateY(100%);
  }
}

/* step 1 (prepareSweep): held at its start, the frost covering the preview,
   until the video plays; then it runs from the start (runSweep) */
.preview-sweep.waiting {
  animation-play-state: paused;
}

/* the colors: the top half. Their top edge fades in, so the trailing side
   doesn't end in a hard straight line; the bottom edge (the reveal edge)
   stays crisp. The mask is on the colors only: on .preview-sweep it would
   cut the frost off from the preview */
.sweep-colors {
  position: absolute;
  inset: 0 0 50%;
  background: var(--sweep-colors);
  opacity: 0.4;
  -webkit-mask-image: linear-gradient(transparent, #000 16%);
  mask-image: linear-gradient(transparent, #000 16%);
}

/* the frost: the bottom half, blurring what's under it (the low quality look).
   The same blur as .thumb-veil, the still's blur before the sweep, so the
   handover from one to the other doesn't show */
.sweep-frost {
  position: absolute;
  inset: 50% 0 0;
}

.sweep-frost,
.thumb-veil {
  -webkit-backdrop-filter: blur(6px) saturate(85%);
  backdrop-filter: blur(6px) saturate(85%);
}

/* a video's or folder's still, blurred until its preview's first play
   (thumbVeiled in the script): over the still, under the preview's status
   pill and the badges; the sweep takes over from it */
.thumb-veil {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* reduced motion: nothing slides; the colors fade in and out over the
   preview, already sharp */
@media (prefers-reduced-motion: reduce) {
  .preview-sweep {
    top: 0;
    height: 100%;
    opacity: 0;
    animation: card-glow 1.4s ease-in-out;
  }

  .sweep-colors {
    inset: 0;
  }

  .sweep-frost {
    display: none;
  }
}

/* fades in to 0.6 and out again (the sweep with reduced motion) */
@keyframes card-glow {
  50% {
    opacity: 0.6;
  }
}

/* ── Selection mode ── */
/* folders still open, but stand back */
.card.selecting.folder {
  opacity: 0.55;
}

/* over the still / preview and the badges, under the check circle */
.select-tint {
  position: absolute;
  z-index: 2;
  inset: 0;
  border-radius: inherit;
  background: rgba(45, 108, 223, 0.28);
  pointer-events: none;
}

.check {
  position: absolute;
  z-index: 3; /* above the still, preview and loading cover */
  top: 0.45rem;
  right: 0.45rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border: 2px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  box-sizing: border-box;
  pointer-events: none;
  transition:
    background 0.12s,
    border-color 0.12s;
}

.check.on {
  border-color: #2d6cdf;
  background: #2d6cdf;
}

.check svg {
  width: 1.05rem;
  height: 1.05rem;
  fill: #fff;
}

/* picked: shrinks a little inside a blue outline */
.card.selected {
  transform: scale(0.95);
  box-shadow: 0 0 0 3px #2d6cdf;
}

.card.selected:hover {
  transform: scale(0.95);
}

/* ── Folder / file ── */

/* folders show loading dots just outside their edge, so the card can't clip;
   the top of .folder-wrap rounds itself instead */
.card.folder {
  --card-radius: var(--folder-radius);
  overflow: visible;
  /* its glass is drawn by ::before below, so its layers stay inside the card */
  isolation: isolate;
  background: transparent;
  border-color: var(--edge);
  box-shadow: var(--edge-shine);
  /* Space between folders (Settings → Look → Space between folders): the grid's
     gap is --grid-gap, so each side moves by half the difference (negative =
     closer). The row span adds the same under it (measureSpan) */
  --own-gap: var(--folder-gap);
  margin-inline: calc((var(--own-gap) - var(--grid-gap)) / 2);
}

/* folders directly inside .lock or .bin: their own spacing (Settings → Look →
   Space between top folders) */
.card.folder.top-folder {
  --own-gap: var(--top-folder-gap);
}

@media (max-width: 480px) {
  .card.folder {
    margin-inline: calc(0.75 * (var(--own-gap) - var(--grid-gap)) / 2);
  }
}

/* Hover, like a photo / video card: the card stays put and only the preview
   inside zooms (.folder-still and the playing clip, below). Folders with no
   preview still lift */
.card.folder.has-preview:not(.selected):hover {
  transform: none;
}

/* The folder's dark frosted glass, like the top bar's: the sky shows through,
   blurred. How dark: the top bar's darkness × --folder-darkness-ratio
   (Settings → Look → Top bar darkness, Folder darkness ratio); the light
   sheen on top follows --glass-opacity (Glass strength). On a layer of its
   own instead of the card: a blur on the card itself would hide the page from
   its glass border (::after), which could then only blur the card */
.card.folder::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: calc(-1 * var(--card-border));
  border-radius: var(--card-radius);
  background:
    linear-gradient(
      145deg,
      rgba(255, 255, 255, calc(0.09 * var(--glass-opacity))),
      rgba(255, 255, 255, calc(0.025 * var(--glass-opacity)))
    ),
    rgba(5, 4, 10, calc(var(--topbar-darkness) * var(--folder-darkness-ratio)));
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
  pointer-events: none;
}

/* a brighter rim; no dark shadow under it */
.card.folder:hover {
  border-color: var(--edge-strong);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

/* see-through, so the card's glass is what shows behind the icon
   (a playing preview still covers it) */
.card.folder .folder-wrap {
  background: transparent;
}

/* The folder's name sits on the bottom of its preview, over a band of blur
   (.force-glass on it: blurred even with Glass effect off) and a light dark
   layer, so it reads on any picture. --folder-name-h is the band's height (it
   fits the name: leave it); --folder-extra-h is how much taller than a square
   the preview is, on top of the band (.with-name below): tokens.css, set by
   Settings → Look → Preview extra height (on every device). The name stays
   the same size */
.card.folder,
.card.video {
  --folder-name-h: 2.8rem;
  --folder-grow: calc(var(--folder-name-h) + var(--folder-extra-h));
}

.card.folder .folder-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  box-sizing: border-box;
  height: var(--folder-name-h);
  background: rgba(8, 7, 14, 0.35);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
  backdrop-filter: blur(14px) saturate(130%);
  color: #ece8f7;
  /* Semibold (Comic Code has it: styles/fonts.css); the big first letter keeps its Bold */
  font-weight: 600;
}

.card.folder .folder-wrap {
  overflow: hidden;
  border-radius: calc(var(--card-radius) - var(--card-border));
}

/* the square plus the name band: a pseudo-element as wide as nothing and as
   tall as the card is wide + the band (padding percentages follow the width) */
.card.folder .folder-wrap.with-name {
  aspect-ratio: auto;
}

.card.folder .folder-wrap.with-name::before {
  content: '';
  flex: none;
  width: 0;
  padding-bottom: calc(100% + var(--folder-grow));
}

/* the icon sits in the part above the name band, also on the square folders
   without a preview */
.card.folder .folder-wrap:has(.folder-name) .folder-icon {
  margin-bottom: var(--folder-name-h);
}

.folder-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1 / 1;
  background: #1e1e1e;
}

/* bottom row of a folder card: its contents, on the right (its dates are in
   its menu) */
.folder-badges {
  position: absolute;
  bottom: var(--badge-inset);
  left: var(--badge-inset);
  right: var(--badge-inset);
  display: flex;
  flex-wrap: wrap-reverse;
  align-items: center;
  gap: 0.3rem;
  pointer-events: none;
}

/* above the name band, on the cards that have one (not "Most played") */
.folder-wrap:has(.folder-name) .folder-badges {
  bottom: calc(var(--badge-inset) + var(--folder-name-h));
}

.folder-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  white-space: nowrap;
  color: #ccc;
  font-size: 0.7rem;
  border-radius: 4px;
}

/* ── Data badges ──
   Dates, counts, duration, size and quality: frosted glass (.badge-glass,
   tokens.css; Settings → Look → Badge darkness / Badge glass ratio) */
.folder-badge,
.info-badge {
  /* the glass rim is inside the old size, so the badges don't grow */
  padding: calc(0.2rem - 1px) calc(0.45rem - 1px);
}

/* folders with nothing to preview: no glass, just white text, which reads
   fine on the folder card itself */
.folder-wrap.no-preview .folder-badge {
  padding: 0;
  background: none;
  border: none;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  color: #fff;
}

/* Hearted photos and videos (not in Most played): their badges (plays, size,
   quality, duration) have the .theme-glass class, the same as the video
   player's buttons (tokens.css), instead of the colored ring. Only how opaque
   the colors are differs: stronger than on the player so they read on a
   preview. --colored-badge-boost: how many times more opaque */
.card.colored-badges {
  --colored-badge-boost: 2.5;
  --theme-glass-alpha: min(
    90%,
    calc(var(--glass-opacity) * var(--video-control-ratio) * var(--colored-badge-boost) * 100%)
  );
}

/* videos, images and size in one badge, pushed to the right */
.folder-contents {
  gap: 0.5rem;
  margin-left: auto;
}

.folder-contents .count {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
}

.folder-badge svg {
  width: 0.85rem;
  height: 0.85rem;
  fill: currentColor;
}

.folder-icon {
  font-size: 4rem;
  line-height: 1;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));
  transition: transform 0.15s;
}

/* the folder preview's still (/api/folder-thumb), filling the card over the
   icon, under the preview clip (which comes after it). Hidden until it has
   loaded, so a slow or missing one never shows a broken image: the icon
   shows meanwhile */
.folder-still {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition:
    opacity 0.2s,
    transform 0.2s;
}

.folder-still.loaded {
  opacity: 1;
}

.card:hover .folder-icon {
  transform: scale(1.08);
}

/* ── Media ── */
/* square, or the media's own shape if it's portrait (mediaRatio, set on it) */
.media-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  background: #0d0d0d;
  overflow: hidden;
  /* sits inside the card's border, so its corners are smaller by that much */
  border-radius: calc(var(--card-radius) - var(--card-border));
}

.media-wrap img,
.media-wrap video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.2s;
}

/* A video's preview is as much taller than its picture shape as a folder's is
   than a square (--folder-grow): its width ÷ ratio, plus the same extra. 100cqw
   is the card's width (the card is a size container, for this) */
.card.video {
  container-type: inline-size;
}

.media-wrap.video-wrap {
  aspect-ratio: auto;
  height: calc(100cqw / var(--media-ratio) + var(--folder-grow));
}

/* the preview (PreviewVideo) zooms with the still underneath it */
.preview-video {
  transition: transform 0.2s;
}

/* the same zoom for a folder's preview (its still and the playing clip) */
.card:hover .media-wrap img,
.card:hover .media-wrap .preview-video,
.card.folder:hover .folder-still,
.card.folder:hover .preview-video {
  transform: scale(1.2);
}

/* dark box until the still image has loaded */
.placeholder {
  position: absolute;
  inset: 0;
  background: #0d0d0d;
  z-index: 1;
}

.thumb-failed {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.5rem;
  color: #c0392b;
}

/* ── Video badges ── */
.video-badges {
  position: absolute;
  bottom: var(--badge-inset);
  left: var(--badge-inset);
  right: var(--badge-inset);
  display: flex;
  align-items: center;
  gap: 0.3rem;
  pointer-events: none;
}

.info-badge,
.ts-badge {
  color: #fff;
  font-size: 0.7rem;
  border-radius: 4px;
}

.ts-badge {
  padding: 0.2rem 0.45rem;
}

/* date added, duration, size and quality: glass (Data badges, above), the
   first three with a small icon; it sits 1px closer to its text so all fit */
.info-badge {
  display: inline-flex;
  align-items: center;
  gap: calc(0.25rem - 1px);
  white-space: nowrap;
}

/* the resolution, top-right: a little bolder, as a tag */
.quality-badge {
  position: absolute;
  top: var(--badge-inset);
  right: var(--badge-inset);
  font-weight: 700;
  letter-spacing: 0.02em;
  pointer-events: none;
}

/* selection mode: the check circle has the corner, so it sits just left of
   it (the check's inset + its width + a gap) */
.card.selecting .quality-badge {
  right: calc(0.45rem + 1.6rem + 0.3rem);
}

.info-badge svg {
  width: 0.8rem;
  height: 0.8rem;
  fill: currentColor;
}

/* ── The top-left stack ── */
/* The badges and pills of the card's top-left corner, one under the other
   (StackBadge.vue orders them by BADGES' priority and opens / closes each).
   Stays clear of the quality badge (top-right) on narrow cards, unless that
   one is hidden: while a temporal badge is visible (.stack-busy), the stack
   uses the whole width. Above the card's dark placeholder (z-index 1, which it
   follows in the page), under the selection tint and check */
.badge-stack {
  position: absolute;
  z-index: 1;
  top: var(--badge-inset);
  left: var(--badge-inset);
  max-width: calc(50% - var(--badge-inset));
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  pointer-events: none;
}

/* the metadata badges (the views, "Whole video"), side by side at the bottom of
   the column. Sits after every slot of the column (their `order` is negative);
   the badges in it are ordered by priority too, and shrink to no width when
   closed (StackBadge.vue), so the row is 0 tall with none open */
.badge-row {
  order: 0;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  max-width: 100%;
}

/* every badge and pill of the stack shows its whole text: wrapped onto more
   lines when it doesn't fit the width, never cut with an ellipsis */
.badge-stack .info-badge {
  white-space: normal;
  overflow-wrap: anywhere;
}

/* a photo has no quality badge at its top-right, and a card showing a temporal
   badge has hidden it: the stack may be as wide as the card */
.media-wrap:not(.video-wrap) .badge-stack,
.card.stack-busy .badge-stack {
  max-width: calc(100% - 2 * var(--badge-inset));
}

/* The badges of the top-right corner (the quality; any new one gets this
   class): hidden while a temporal badge of the stack is visible, so the stack
   has the room. Back once the last one has gone (after the stack has closed,
   hence the delay) */
.corner-badge {
  transition:
    opacity 0.25s ease 0.3s,
    transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) 0.3s;
}

.card.stack-busy .corner-badge {
  opacity: 0;
  transform: translateX(0.6rem);
  transition-delay: 0s;
}

@media (prefers-reduced-motion: reduce) {
  .corner-badge {
    transition: none;
  }
}

/* the views and the other badges of the stack are inline, not positioned */
.badge-stack .plays-badge {
  font-variant-numeric: tabular-nums;
}

/* ── "Compressed!" ──
   A compressed copy not opened yet: a badge like the others on the preview
   (same size, corners, glass blur and rim), tinted with the purple of the top
   bar's compress indicator (CompressButton.vue's count bubble, #8a5cf6) over
   the dark badge glass. In the top-left stack, under the status pill */
.compressed-badge {
  background:
    linear-gradient(145deg, rgba(138, 92, 246, 0.72), rgba(138, 92, 246, 0.5)),
    rgba(5, 4, 10, var(--badge-darkness));
  -webkit-backdrop-filter: blur(10px) saturate(150%);
  backdrop-filter: blur(10px) saturate(150%);
  border: 1px solid var(--edge);
  box-shadow: var(--edge-shine);
  color: #fff;
  font-weight: 700;
  letter-spacing: 0.02em;
}

/* the "Most played" section: just the views, nothing else on the preview, so
   bottom-right, like the views of the folder cards there (elsewhere they're in
   the top-left stack, above) */
.plays-badge.views-only {
  position: absolute;
  bottom: var(--badge-inset);
  right: var(--badge-inset);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  /* switching the app mode: it pops in from (or shrinks into) its corner */
  transform-origin: bottom right;
}

.mode-badge-enter-active,
.mode-badge-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.mode-badge-enter-from,
.mode-badge-leave-to {
  opacity: 0;
  transform: scale(0.6);
}

/* a folder's views, in the row with its counts: opens to its width (and back),
   so the counts beside it slide along instead of jumping */
.mode-count-enter-active,
.mode-count-leave-active {
  overflow: hidden;
  transition:
    max-width 0.3s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.25s ease;
}

.mode-count-enter-from,
.mode-count-leave-to {
  max-width: 0;
  opacity: 0;
}

.mode-count-enter-to,
.mode-count-leave-from {
  /* wider than any count: the most it opens to */
  max-width: 5rem;
}

@media (prefers-reduced-motion: reduce) {
  .mode-badge-enter-active,
  .mode-badge-leave-active,
  .mode-count-enter-active,
  .mode-count-leave-active {
    transition: opacity 0.2s;
  }

  .mode-badge-enter-from,
  .mode-badge-leave-to {
    transform: none;
  }

  .mode-count-enter-from,
  .mode-count-leave-to {
    max-width: 5rem;
  }
}

.ts-badge {
  background: #c0392b;
  font-weight: 700;
}

.duration-badge {
  margin-left: auto;
}

/* a photo's size: at the right end of its badge row (a video's duration
   already is, .duration-badge) */
.video-badges > .size-badge:first-child {
  margin-left: auto;
}

/* ── Double-tap heart ──
   Hearting a photo / video is a double tap on its card (the script): a big
   heart pops in the middle of the preview with its burst, then goes; an
   un-heart shows it empty, fading. Hearted cards show it by their colored
   badges, there's no heart on them. The heart below is the badges' size,
   scaled up (the burst's sizes follow). Above the preview and its badges,
   and it doesn't take the pointer */
.like-pop {
  position: absolute;
  z-index: 4;
  top: 50%;
  left: 50%;
  width: 1.35rem;
  height: 1.35rem;
  transform: translate(-50%, -50%) scale(3.6);
  pointer-events: none;
  /* no filter (e.g. a drop shadow) here: it would stop the heart's glass
     from seeing, and blurring, the video behind it */
}

/* the heart shape cut out of its background (ICON_HEART in icons.ts), so it
   can be filled with any color or gradient from CSS */
.heart {
  --heart-shape: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'/%3E%3C/svg%3E");
  display: block;
  width: 1.35rem;
  height: 1.35rem;
  -webkit-mask: var(--heart-shape) center / contain no-repeat;
  mask: var(--heart-shape) center / contain no-repeat;
  /* not hearted: bare glass in the heart's shape, the badges' glass
     (.badge-glass, tokens.css): the video behind blurred, under a light
     sheen and the dark layer (Settings → Look → Badge darkness, Badge glass
     ratio). The mask clips the blur too, so it's exactly heart-shaped */
  --heart-sheen: linear-gradient(
    145deg,
    rgba(255, 255, 255, calc(0.22 * var(--glass-opacity) * var(--badge-glass-ratio))),
    rgba(255, 255, 255, calc(0.04 * var(--glass-opacity) * var(--badge-glass-ratio)))
  );
  background: var(--heart-sheen), rgba(5, 4, 10, var(--badge-darkness));
  -webkit-backdrop-filter: blur(10px) saturate(150%);
  backdrop-filter: blur(10px) saturate(150%);
  position: relative; /* anchors the rim */
}

/* The glass rim of the badges (--edge, tokens.css), following the heart's
   outline: its stroke, of which the heart's own mask keeps the inner half,
   so it's a thin line just inside the edge, like a badge's border */
.heart::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--edge);
  --heart-outline: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' fill='none' stroke='%23000' stroke-width='2.4' stroke-linejoin='round'/%3E%3C/svg%3E");
  -webkit-mask: var(--heart-outline) center / contain no-repeat;
  mask: var(--heart-outline) center / contain no-repeat;
}

/* hearted: glass tinted red. The red is see-through enough for the blurred
   video to show in it, under a stronger sheen, with the same rim, a little
   brighter so it reads on the color */
.like-pop.on .heart {
  --heart-sheen: linear-gradient(
    145deg,
    rgba(255, 255, 255, calc(0.4 * var(--glass-opacity) * var(--badge-glass-ratio))),
    rgba(255, 255, 255, calc(0.05 * var(--glass-opacity) * var(--badge-glass-ratio))) 60%
  );
  background: var(--heart-sheen), rgba(255, 51, 71, 0.6);
  -webkit-backdrop-filter: blur(10px) saturate(180%);
  backdrop-filter: blur(10px) saturate(180%);
}

.like-pop.on .heart::after {
  background: var(--edge-strong);
}

/* hearted, on a card with colored badges: the heart wears the same colored
   glass as them (--theme-glass, tokens.css) instead of red */
.card.colored-badges .like-pop.on .heart {
  /* no white sheen (it made the heart lighter than the badges), and the
     badges' own blur and rim */
  background: var(--theme-glass);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
}

.card.colored-badges .like-pop.on .heart::after {
  background: var(--edge);
}

:global(html.no-glass) .card.colored-badges .like-pop.on .heart {
  background: var(--theme-glass), rgba(14, 13, 22, 0.85);
}

/* "Glass effect" off: nothing blurred shows through, so a see-through red
   would just look faded: solid red under the sheen instead */
:global(html.no-glass) .like-pop.on .heart {
  background: var(--heart-sheen), #ff3347;
}

/* the big heart has no rim: just the glass in its shape */
.like-pop .heart::after {
  display: none;
}

/* ── "Like" burst (POP_MS long in the script) ──
   A glow flares behind it, two rings swell from the middle one after the
   other and empty out, a ring of dots flies off, the heart slams in too big
   with a little wobble, settles, and fades out at the end */
.like-pop.pop .heart {
  animation: heart-pop 1.2s cubic-bezier(0.17, 0.89, 0.32, 1.28) both;
}

/* un-hearted: the empty heart shrinks a little and fades */
.like-pop.unlike .heart {
  animation: heart-fade 0.8s ease-out both;
}

/* a soft pink-to-purple glow flaring behind the heart (a separate layer: a
   filter on the heart itself would cut off its glass) */
.like-glow {
  position: absolute;
  inset: -60%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    rgba(255, 126, 182, 0.85),
    rgba(180, 140, 255, 0.45) 55%,
    transparent
  );
  filter: blur(4px);
  animation: like-glow 1.2s ease-out both;
}

@keyframes like-glow {
  0%,
  15% {
    opacity: 0;
    transform: scale(0.3);
  }
  35% {
    opacity: 1;
    transform: scale(1.15);
  }
  100% {
    opacity: 0;
    transform: scale(1.6);
  }
}

@keyframes heart-fade {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.7);
  }
}

.burst {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.ring {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border-radius: 50%;
  border: 0.675rem solid #b48cff;
  animation: ring-swell 0.5s ease-out both;
}

/* the second ring: a beat later, swelling further, cyan */
.ring-late {
  border-color: #9fd8ff;
  animation: ring-swell-late 0.6s ease-out 0.15s both;
}

.dot {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0.26rem;
  height: 0.26rem;
  margin: -0.13rem 0 0 -0.13rem;
  border-radius: 50%;
  background: #ff7eb6;
  transform: rotate(var(--angle)) translateY(0) scale(1);
  animation: dot-fly 0.7s cubic-bezier(0.2, 0.7, 0.3, 1) 0.22s both;
}

/* every other dot: smaller, blue, and flying a little further */
.dot:nth-child(odd) {
  background: #9fd8ff;
  --dot-scale: 0.7;
  --dot-reach: -2.1rem;
}

@keyframes heart-pop {
  0%,
  22% {
    opacity: 1;
    transform: scale(0) rotate(0);
  }
  42% {
    transform: scale(1.45) rotate(-8deg);
  }
  54% {
    transform: scale(0.88) rotate(5deg);
  }
  64% {
    transform: scale(1.08) rotate(-2deg);
  }
  74%,
  85% {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
  100% {
    opacity: 0;
    transform: scale(1.15);
  }
}

@keyframes ring-swell {
  0% {
    transform: scale(0);
    border-color: #b48cff;
    border-width: 0.675rem;
  }
  55% {
    transform: scale(1.2);
    border-color: #ff7eb6;
    border-width: 0.675rem;
  }
  100% {
    transform: scale(1.6);
    border-color: #ff7eb6;
    border-width: 0;
  }
}

@keyframes ring-swell-late {
  0% {
    transform: scale(0.4);
    border-width: 0.4rem;
    opacity: 0.9;
  }
  100% {
    transform: scale(2.2);
    border-width: 0;
    opacity: 0;
  }
}

@keyframes dot-fly {
  0% {
    opacity: 0;
    transform: rotate(var(--angle)) translateY(-0.5rem) scale(calc(1.4 * var(--dot-scale, 1)));
  }
  15% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: rotate(var(--angle)) translateY(var(--dot-reach, -1.75rem)) scale(0.2);
  }
}

/* reduced motion: the heart just fades in and out where it is, no burst */
@media (prefers-reduced-motion: reduce) {
  .like-pop.pop .heart,
  .like-pop.unlike .heart {
    animation: card-glow 0.8s ease-in-out both;
  }

  .ring,
  .dot,
  .like-glow {
    animation: none;
  }

  .burst {
    display: none;
  }
}

/* ── Label ── */
.label {
  margin: 0;
  padding: 0.5rem 0.6rem 0.6rem;
  font-size: 0.78rem;
  color: #bbb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  line-height: 1.3;
}

.card.folder .label::first-letter {
  font-size: 1.4rem;
  font-weight: 700;
  text-transform: capitalize;
  color: #e8e8e8;
}
</style>
