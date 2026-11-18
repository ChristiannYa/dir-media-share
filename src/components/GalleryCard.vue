<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import FileMenu from '@/components/FileMenu.vue'
import FolderMenu from '@/components/FolderMenu.vue'
import LoadingDots from '@/components/LoadingDots.vue'
import PreviewVideo from '@/components/PreviewVideo.vue'
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
import { ICON_EYE } from '@/icons'
import { settings } from '@/settings'
import { useContextHold } from '@/composables/useContextHold'
import { MEDIA_STATUS_KEY } from '@/composables/useMediaStatus'
import type { Entry } from '@/types'
import { isMediaEntry } from '@/utils/entry'
import { hasPlayed } from '@/utils/firstPlays'
import { formatDuration, formatQuality, formatSize } from '@/utils/format'

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
  /** The heart was tapped: `on` is the state it should switch to */
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

/** "1 view", "12 views" */
function playsLabel(n: number): string {
  return n === 1 ? '1 view' : `${n} views`
}

function onClick() {
  if (hold.consumeClick()) return // the press opened the menu
  emit('open', props.entry)
}

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

/** Length of the heart's "like" burst (keep in sync with the .pop animations below) */
const POP_MS = 800
/** The heart was just tapped on: plays the burst (only then, not when the card appears hearted) */
const popping = ref(false)
let popTimer: ReturnType<typeof setTimeout> | undefined

function toggleFavorite() {
  const on = !props.entry.favorite
  clearTimeout(popTimer)
  popping.value = on
  if (on) popTimer = setTimeout(() => (popping.value = false), POP_MS)
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
  () => [settings.gridGap, settings.folderGap, settings.topFolderGap],
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
      <div v-if="!viewsOnly && !bare" class="video-badges">
        <button
          v-if="!linkOnly"
          type="button"
          class="fav-btn"
          :class="{ on: entry.favorite, pop: popping }"
          :aria-pressed="!!entry.favorite"
          :title="entry.favorite ? 'Remove from favorites' : 'Add to favorites'"
          @click.stop="toggleFavorite"
        >
          <span class="heart" aria-hidden="true" />
          <!-- "like" burst: a ring swells and empties, dots fly out, the heart pops in -->
          <span v-if="popping" class="burst" aria-hidden="true">
            <span class="ring" />
            <span
              v-for="i in 7"
              :key="i"
              class="dot"
              :style="{ '--angle': `${(i * 360) / 7}deg` }"
            />
          </span>
        </button>
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
      <!-- top-left: how many times it was played (not in selection mode: the check is
           there); viewsOnly: bottom-right, where the folder cards have theirs.
           Pops in / out when the app mode (or selection mode) switches -->
      <Transition name="mode-badge">
        <span
          v-if="!selecting && recordsVideoData && !bare"
          class="info-badge plays-badge"
          :class="[badgeGlass, { 'views-only': viewsOnly }]"
          :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
          {{ entry.plays ?? 0 }}
        </span>
      </Transition>
      <!-- top-right: the quality -->
      <span
        v-if="quality && !viewsOnly && !bare"
        class="info-badge quality-badge"
        :class="badgeGlass"
      >
        {{ quality }}
      </span>
      <div v-if="!viewsOnly && !bare" class="video-badges">
        <!-- bottom-left: the TS warning -->
        <span v-if="entry.needs_fix" class="ts-badge" :title="TS_BADGE_TITLE">TS</span>
        <!-- heart, left of the duration and size (not on a link-only card) -->
        <button
          v-if="!linkOnly"
          type="button"
          class="fav-btn"
          :class="{ on: entry.favorite, pop: popping }"
          :aria-pressed="!!entry.favorite"
          :title="entry.favorite ? 'Remove from favorites' : 'Add to favorites'"
          @click.stop="toggleFavorite"
        >
          <span class="heart" aria-hidden="true" />
          <!-- "like" burst: a ring swells and empties, dots fly out, the heart pops in -->
          <span v-if="popping" class="burst" aria-hidden="true">
            <span class="ring" />
            <span
              v-for="i in 7"
              :key="i"
              class="dot"
              :style="{ '--angle': `${(i * 360) / 7}deg` }"
            />
          </span>
        </button>
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
   the preview is, on top of the band (.with-name below): raise it for a taller
   folder, the name stays the same size */
.card.folder,
.card.video {
  --folder-name-h: 2.8rem;
  --folder-extra-h: 2.2rem;
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

/* how many times it was played, top-left (the quality is top-right) */
.plays-badge {
  position: absolute;
  top: var(--badge-inset);
  left: var(--badge-inset);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

/* the "Most played" section: nothing else on the preview, so bottom-right,
   like the views of the folder cards there */
.plays-badge.views-only {
  top: auto;
  left: auto;
  bottom: var(--badge-inset);
  right: var(--badge-inset);
}

/* switching the app mode: the views badge pops in from (or shrinks into) its
   corner */
.plays-badge {
  transform-origin: top left;
}

.plays-badge.views-only {
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

/* ── Favorite heart ── */
/* A heart-shaped badge, no box around it: as tall as the duration / size
   badges. Pushed right with them; the duration then sits right after it */
.fav-btn {
  position: relative; /* anchors the burst */
  margin-left: auto;
  display: inline-flex;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  /* no filter (e.g. a drop shadow) here: it would stop the heart's glass
     from seeing, and blurring, the video behind it */
  /* the badge row ignores the pointer; the heart doesn't */
  pointer-events: auto;
  transition:
    opacity 0.15s,
    transform 0.15s;
}

.fav-btn + .duration-badge {
  margin-left: 0;
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
.fav-btn.on .heart {
  --heart-sheen: linear-gradient(
    145deg,
    rgba(255, 255, 255, calc(0.4 * var(--glass-opacity) * var(--badge-glass-ratio))),
    rgba(255, 255, 255, calc(0.05 * var(--glass-opacity) * var(--badge-glass-ratio))) 60%
  );
  background: var(--heart-sheen), rgba(255, 51, 71, 0.6);
  -webkit-backdrop-filter: blur(10px) saturate(180%);
  backdrop-filter: blur(10px) saturate(180%);
}

.fav-btn.on .heart::after {
  background: var(--edge-strong);
}

/* hearted, on a card with colored badges: the heart wears the same colored
   glass as them (--theme-glass, tokens.css) instead of red */
.card.colored-badges .fav-btn.on .heart {
  /* no white sheen (it made the heart lighter than the badges), and the
     badges' own blur and rim */
  background: var(--theme-glass);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
}

.card.colored-badges .fav-btn.on .heart::after {
  background: var(--edge);
}

:global(html.no-glass) .card.colored-badges .fav-btn.on .heart {
  background: var(--theme-glass), rgba(14, 13, 22, 0.85);
}

/* "Glass effect" off: nothing blurred shows through, so a see-through red
   would just look faded: solid red under the sheen instead */
:global(html.no-glass) .fav-btn.on .heart {
  background: var(--heart-sheen), #ff3347;
}

/* ── "Like" burst (POP_MS long in the script) ──
   Like X's: the heart vanishes, a ring swells from the middle and empties
   out, dots fly off around it, then the heart pops back in, slightly too big */
.fav-btn.pop .heart {
  animation: heart-pop 0.8s cubic-bezier(0.17, 0.89, 0.32, 1.28) both;
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
  animation: ring-swell 0.4s ease-out both;
}

.dot {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0.22rem;
  height: 0.22rem;
  margin: -0.11rem 0 0 -0.11rem;
  border-radius: 50%;
  background: #ff7eb6;
  transform: rotate(var(--angle)) translateY(0) scale(1);
  animation: dot-fly 0.55s ease-out 0.22s both;
}

.dot:nth-child(odd) {
  background: #9fd8ff;
}

@keyframes heart-pop {
  0%,
  28% {
    transform: scale(0);
  }
  60% {
    transform: scale(1.25);
  }
  80% {
    transform: scale(0.94);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes ring-swell {
  0% {
    transform: scale(0);
    border-color: #b48cff;
    border-width: 0.675rem;
  }
  55% {
    transform: scale(1.1);
    border-color: #ff7eb6;
    border-width: 0.675rem;
  }
  100% {
    transform: scale(1.35);
    border-color: #ff7eb6;
    border-width: 0;
  }
}

@keyframes dot-fly {
  0% {
    opacity: 0;
    transform: rotate(var(--angle)) translateY(-0.5rem) scale(1.2);
  }
  15% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: rotate(var(--angle)) translateY(-1.35rem) scale(0.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fav-btn.pop .heart,
  .ring,
  .dot {
    animation: none;
  }

  .burst {
    display: none;
  }
}

.fav-btn:hover {
  transform: scale(1.12);
}

/* an empty heart only shows on the pointed card; touch screens always show it */
@media (hover: hover) {
  .fav-btn:not(.on) {
    opacity: 0;
  }

  .card:hover .fav-btn,
  .fav-btn:focus-visible {
    opacity: 1;
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
