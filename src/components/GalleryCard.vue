<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import FileMenu from '@/components/FileMenu.vue'
import FolderMenu from '@/components/FolderMenu.vue'
import LoadingDots from '@/components/LoadingDots.vue'
import PreviewVideo from '@/components/PreviewVideo.vue'
import { fileUrl, folderPreviewUrl, previewGeneration, previewUrl, thumbUrl } from '@/api'
import { recordsVideoData } from '@/appMode'
import { THEMED_NAME_PARENTS, TS_BADGE_TITLE } from '@/constants'
import { ICON_EYE } from '@/icons'
import { settings } from '@/settings'
import { useContextHold } from '@/composables/useContextHold'
import { MEDIA_STATUS_KEY } from '@/composables/useMediaStatus'
import type { Entry } from '@/types'
import { isMediaEntry } from '@/utils/entry'
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

/** Videos: "1080p", "4K60"…; null if the size is unknown */
const quality = computed(() =>
  props.entry.kind === 'video'
    ? formatQuality(props.entry.width, props.entry.height, props.entry.fps)
    : null,
)

/**
 * A folder inside cinema, know, leaks or rand (THEMED_NAME_PARENTS, any depth,
 * leading dots and case ignored): its name is drawn in the theme colors, if
 * Settings → Look → Colored folder names is on
 */
const themedName = computed(() => {
  if (!settings.themedFolderNames || props.entry.kind !== 'folder') return false
  const parents = props.entry.path.split('/').slice(0, -1)
  return parents.some((p) => THEMED_NAME_PARENTS.includes(p.replace(/^\.+/, '').toLowerCase()))
})

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
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0
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

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth && img.naturalHeight) loadedRatio.value = img.naturalWidth / img.naturalHeight
  onMediaLoad(trackKey.value)
}

/**
 * The card's preview played for the first time since the page loaded: a
 * glow in the theme colors pulses around the card (two beats, then gone)
 */
const pulsing = ref(false)
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
        // hearted photos and videos show their ring (theme colors); the rest get the glass border instead
        'plain-ring': isMedia && !entry.favorite,
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
    <!-- a new preview just played: a glow in the theme colors pulses around the card -->
    <span v-if="pulsing" class="pulse" aria-hidden="true" @animationend="pulsing = false" />
    <!-- selection mode: a faint blue layer over picked files -->
    <span v-if="selecting && selected" class="select-tint" aria-hidden="true" />
    <!-- selection mode: files get a check circle (their menu can't be opened meanwhile) -->
    <span
      v-if="selecting && entry.kind !== 'folder'"
      class="check"
      :class="{ on: selected }"
      aria-hidden="true"
    >
      <svg v-if="selected" viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
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
      :class="{ 'no-preview': !hasPreview(entry) }"
    >
      <span class="folder-icon">📁</span>
      <!-- :key: reloads with clips made with the new settings after they change -->
      <PreviewVideo
        v-if="hasPreview(entry) && showPreview(trackKey)"
        :key="previewGeneration"
        kind="folder"
        :path="entry.path"
        :active="isPreviewActive(trackKey)"
        :api-url="folderPreviewUrl(entry.path, folderPick)"
        @loaded="onPreviewLoaded(trackKey)"
        @playing="onPreviewPlaying(trackKey)"
        @first-play="pulsing = true"
        @error="onPreviewError(trackKey)"
      />
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
          <span
            v-if="showFolderViews"
            class="count"
            :title="`${playsLabel(entry.plays ?? 0)} of what's inside, on every device`"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
            {{ entry.plays }}
          </span>
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
    </div>

    <!-- Image -->
    <div
      v-else-if="entry.kind === 'image'"
      class="media-wrap"
      :style="{ aspectRatio: mediaRatio }"
    >
      <div v-if="isThumbLoading(trackKey)" class="placeholder" />
      <img
        :src="fileUrl(entry.path)"
        loading="lazy"
        :alt="entry.name"
        @load="onImageLoad"
        @error="onMediaError(trackKey)"
      />
      <!-- viewsOnly: just how many times it was shown, bottom-right like a folder's -->
      <span
        v-if="viewsOnly"
        class="badge-glass info-badge plays-badge views-only"
        :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
        {{ entry.plays ?? 0 }}
      </span>
      <div v-if="!viewsOnly" class="video-badges">
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
        <span v-if="entry.size" class="badge-glass info-badge size-badge" title="File size">
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
      class="media-wrap"
      :style="{ aspectRatio: mediaRatio }"
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
        :path="entry.path"
        :active="isPreviewActive(trackKey)"
        :api-url="previewUrl(entry.path)"
        @loaded="onPreviewLoaded(trackKey)"
        @playing="onPreviewPlaying(trackKey)"
        @first-play="pulsing = true"
        @error="onPreviewError(trackKey)"
      />
      <!-- top-left: how many times it was played (not in selection mode: the check is
           there); viewsOnly: bottom-right, where the folder cards have theirs -->
      <span
        v-if="!selecting && recordsVideoData"
        class="badge-glass info-badge plays-badge"
        :class="{ 'views-only': viewsOnly }"
        :title="`${playsLabel(entry.plays ?? 0)}, on every device`"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_EYE" /></svg>
        {{ entry.plays ?? 0 }}
      </span>
      <!-- top-right: the quality -->
      <span v-if="quality && !viewsOnly" class="badge-glass info-badge quality-badge">
        {{ quality }}
      </span>
      <div v-if="!viewsOnly" class="video-badges">
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
        <span v-if="entry.duration" class="badge-glass info-badge duration-badge" title="Duration">
          <!-- clock -->
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"
            />
          </svg>
          {{ formatDuration(entry.duration) }}
        </span>
        <span v-if="entry.size" class="badge-glass info-badge size-badge" title="File size">
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

    <!-- no name in the "Most played" section: only the views there -->
    <p
      v-if="!isMedia && !viewsOnly"
      class="label"
      :class="{ themed: themedName }"
      :title="entry.name"
    >
      <!-- its own box, so a colored name's gradient spans the text, not the whole card -->
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
    <FileMenu
      v-else-if="!linkOnly"
      ref="fileMenu"
      :entry="entry"
      @changed="emit('changed')"
    />
  </div>
</template>

<style scoped>
/* ── Card ── */
.card {
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
.card.folder {
  /* how far past the card's padding edge the frame starts: its own border, plus the ring's place on photos and videos */
  --frame-offset: var(--card-border);
}

.card.video,
.card.image {
  --frame-offset: calc(var(--card-border) + var(--ring-width));
}

/* folders, and the photos and videos that aren't hearted (.plain-ring): the
   hearted ones get the colored ring instead, so they stand out */
.card.folder::after,
.card.plain-ring::after {
  content: '';
  position: absolute;
  z-index: -1;
  inset: calc(-1 * (var(--frame-offset) + var(--card-glass-width)));
  padding: var(--card-glass-width);
  /* parallel to the card's corners (and the ring's) */
  border-radius: calc(
    var(--card-radius) + var(--frame-offset) - var(--card-border) + var(--card-glass-width)
  );
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

/* ── Preview pulse ──
   A new preview played: a soft glow in the theme colors swells around the
   card twice and fades. A blurred layer of the colors behind everything
   else on the card (its ring, glass border and folder glass are at -1), so
   only the halo past its edges shows; the colors turn around it as it
   pulses (--ring-angle, registered in styles/ring.css) */
.pulse {
  position: absolute;
  z-index: -2;
  inset: calc(-1 * var(--card-outset));
  border-radius: calc(var(--card-radius) + var(--card-outset));
  background: conic-gradient(
    from var(--ring-angle),
    var(--theme-purple),
    var(--theme-blue),
    var(--theme-cyan),
    var(--theme-green),
    var(--theme-pink),
    var(--theme-purple)
  );
  filter: blur(14px) saturate(var(--ring-vibrancy, 1));
  opacity: 0;
  pointer-events: none;
  animation: card-pulse 1.5s ease-in-out;
}

@keyframes card-pulse {
  0% {
    opacity: 0;
    transform: scale(0.96);
    --ring-angle: 0deg;
  }
  25% {
    opacity: 0.9;
    transform: scale(1.03);
  }
  50% {
    opacity: 0.35;
    transform: scale(1);
  }
  75% {
    opacity: 0.75;
    transform: scale(1.03);
  }
  100% {
    opacity: 0;
    transform: scale(1);
    --ring-angle: 360deg;
  }
}

/* reduced motion: one soft glow, no swelling or turning */
@media (prefers-reduced-motion: reduce) {
  .pulse {
    animation: card-glow 1s ease-in-out;
  }
}

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
  overflow: visible;
  /* its glass is drawn by ::before below, so its layers stay inside the card */
  isolation: isolate;
  background: transparent;
  border-color: var(--edge);
  box-shadow: var(--edge-shine);
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

/* name banner: a slightly darker pane of the same glass, split from the
   icon area by a thin highlight line */
.card.folder .label {
  background: rgba(12, 11, 18, calc(0.25 * var(--glass-opacity)));
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0 0 calc(var(--card-radius) - var(--card-border))
    calc(var(--card-radius) - var(--card-border));
  color: #d4cfe6;
  /* Semibold (Comic Code has it: styles/fonts.css); the big first letter keeps its Bold */
  font-weight: 600;
}

.card.folder .folder-wrap {
  overflow: hidden;
  border-radius: calc(var(--card-radius) - var(--card-border))
    calc(var(--card-radius) - var(--card-border)) 0 0;
}

/* no name banner under it (the "Most played" section): it's the whole card,
   so its bottom corners are rounded too, and the preview stays inside them */
.card.folder.views-only .folder-wrap {
  border-radius: calc(var(--card-radius) - var(--card-border));
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

/* the preview (PreviewVideo) zooms with the still underneath it */
.preview-video {
  transition: transform 0.2s;
}

.card:hover .media-wrap img,
.card:hover .media-wrap .preview-video {
  transform: scale(1.04);
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
  background:
    var(--heart-sheen),
    rgba(5, 4, 10, var(--badge-darkness));
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
  background:
    var(--heart-sheen),
    rgba(255, 51, 71, 0.6);
  -webkit-backdrop-filter: blur(10px) saturate(180%);
  backdrop-filter: blur(10px) saturate(180%);
}

.fav-btn.on .heart::after {
  background: var(--edge-strong);
}

/* "Glass effect" off: nothing blurred shows through, so a see-through red
   would just look faded: solid red under the sheen instead */
:global(html.no-glass) .fav-btn.on .heart {
  background:
    var(--heart-sheen),
    #ff3347;
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

/* Colored folder names (Settings → Look): the theme colors of the ring
   around videos (styles/ring.css), fading into each other along the name */
.label.themed .name {
  background: linear-gradient(
    90deg,
    var(--theme-purple),
    var(--theme-blue),
    var(--theme-cyan),
    var(--theme-green),
    var(--theme-pink)
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* the gradient only fills this box, which is as tall as the small letters:
     padding stretches it over the big first letter's top and the tails of
     g / p / y (on an inline box it doesn't move the text or the line) */
  padding: 0.6rem 0.1rem 0.3rem;
}

/* the big first letter too: see-through, so the gradient shows in it */
.card.folder .label.themed::first-letter {
  color: transparent;
}

/* a cut-off name's "…" in the gradient's last color */
.card.folder .label.themed {
  color: var(--theme-pink);
}
</style>
