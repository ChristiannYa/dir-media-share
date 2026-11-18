<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  reactive,
  readonly,
  ref,
  watch,
} from 'vue'
import BreadcrumbBar from '@/components/BreadcrumbBar.vue'
import GalleryCard from '@/components/GalleryCard.vue'
import MediaLightbox from '@/components/MediaLightbox.vue'
import NightSky from '@/components/NightSky.vue'
import SelectionBar from '@/components/SelectionBar.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import {
  fetchHearted,
  fetchMostPlayed,
  markCompressedSeen,
  markViewed,
  setFavorite,
  shutdownServer,
} from '@/api'
import { recordsVideoData } from '@/appMode'
import {
  ALPHABET_FOLDERS,
  EMPTY_FOLDER_TEXT,
  GRID_COLUMN_WIDTH,
  HEARTED_EMPTY_TEXT,
  HEARTED_POOL,
  HEARTED_SWAP_MS,
  HEARTED_TITLE,
  MOST_PLAYED_EMPTY_TEXT,
  MOST_PLAYED_PARENTS,
  MOST_PLAYED_TITLE,
  REVEAL_MS,
  SHUTDOWN_CONFIRM,
} from '@/constants'
import { useAlphabetIndex } from '@/composables/useAlphabetIndex'
import { playPowerOff } from '@/composables/usePowerOff'
import { backgroundPaused, holdBackgroundPause } from '@/composables/useBackgroundPause'
import {
  RELOAD_GALLERY_KEY,
  REVEAL_ENTRY_KEY,
  SELECTION_KEY,
  setRevealHandler,
  useGallery,
} from '@/composables/useGallery'
import { onCompressFolderChanged } from '@/composables/useCompressQueue'
import { useJobEvents } from '@/composables/useJobEvents'
import { useLightbox } from '@/composables/useLightbox'
import { MEDIA_STATUS_KEY, useMediaStatus } from '@/composables/useMediaStatus'
import { onCaptureResume, takeResumePoint, takeViewerResume } from '@/composables/useResume'
import { loadSharedSettings, settings } from '@/settings'
import type { Entry } from '@/types'
import { isMediaEntry } from '@/utils/entry'
import { haptic } from '@/utils/haptics'
import { sortEntries } from '@/utils/sort'

const media = useMediaStatus()
provide(MEDIA_STATUS_KEY, media)

// open the preview-progress stream now, so events of the first loads arrive
useJobEvents()

const { rootFolderName, currentPath, entries, breadcrumbs, navigate, reload, init } = useGallery({
  onLeave: () => {
    media.reset()
    mostPlayed.value = []
    mostPlayedLoaded.value = false
    clearHearted()
  },
  onEntries: (list) => {
    media.markLoading(list)
    void loadMostPlayed()
    void loadHearted()
  },
  onReload: (list) => {
    media.update(list)
    void loadMostPlayed()
    void loadHearted()
  },
})

// ── Most played ──
// The folders inside .bin and the folders inside those show their most played
// videos and photos (subfolders included) above the grid; counted on the
// server, so the same on every device (Settings → Most played)

/** Leading dots and case ignored, like the colored folder names */
const folderKey = (name: string) => name.replace(/^\.+/, '').toLowerCase()

const isMostPlayedParent = (name: string | undefined) =>
  name !== undefined && MOST_PLAYED_PARENTS.includes(folderKey(name))

/**
 * What the open folder's "Most played" section lists (MOST_PLAYED_PARENTS):
 * - .bin/<x> (e.g. .bin/cinema): its most played subfolders
 * - .bin/<x>/<y> (e.g. .bin/cinema/annaralphs): its most played videos and photos
 * - anywhere else: no section (null)
 */
const mostPlayedKind = computed<'folders' | 'media' | null>(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  if (isMostPlayedParent(parts.at(-2))) return 'folders'
  if (isMostPlayedParent(parts.at(-3))) return 'media'
  return null
})

const mostPlayed = ref<Entry[]>([])
/**
 * The section's list for the open folder has arrived (even if empty), so an
 * empty section shows its placeholder only once it's known to be empty, not
 * while it loads
 */
const mostPlayedLoaded = ref(false)

/** The section's cards keep their own loading / preview state, apart from the grid's card of the same file */
const mostPlayedKey = (entry: Entry) => `most-played:${entry.path}`
/** Only the latest request may fill the section (folders can change quickly) */
let mostPlayedRequest = 0

async function loadMostPlayed() {
  const request = ++mostPlayedRequest
  const path = currentPath.value
  const count = settings.mostPlayedCount
  const kind = mostPlayedKind.value
  // dev mode: no section (src/appMode.ts)
  if (!kind || count <= 0 || !recordsVideoData.value) {
    // still shrinking away (just switched to dev mode): its cards keep what
    // they show until it's gone, then onMostPlayedLeft empties it
    if (mostPlayedLeaving) return
    clearMostPlayed()
    return
  }
  try {
    const list = await fetchMostPlayed(path, count, kind)
    if (request !== mostPlayedRequest || currentPath.value !== path) return
    media.setExtra(list, mostPlayedKey)
    mostPlayed.value = list
    mostPlayedLoaded.value = true
  } catch (e) {
    console.warn(e)
  }
}

// a new count (Settings, on any device once it reloads them) shows right away
watch(() => settings.mostPlayedCount, () => void loadMostPlayed())

function clearMostPlayed() {
  mostPlayed.value = []
  mostPlayedLoaded.value = false
  media.setExtra([], mostPlayedKey, 'most-played')
}

// ── Hearted ──
// Under "Most played", only where it lists videos and photos (.bin/<x>/<y>,
// not .bin/<x>, where it lists folders): random hearted videos and photos
// (subfolders included). When it's full and there are more, one card is
// swapped for another every HEARTED_SWAP_MS: the old one shrinks away and the
// new one grows in its place. Tapping one leads to its card, like "Most played"

const hearted = ref<Entry[]>([])
/** Hearted ones fetched but not shown: what gets swapped in */
let heartedPool: Entry[] = []
/** The section's list for the open folder has arrived (even if empty) */
const heartedLoaded = ref(false)
/** The section's cards keep their own loading / preview state, apart from the other cards of the same file */
const heartedKey = (entry: Entry) => `hearted:${entry.path}`
/** Only the latest request may fill the section */
let heartedRequest = 0

function syncHeartedExtra() {
  media.setExtra(hearted.value, heartedKey, 'hearted')
}

async function loadHearted() {
  const request = ++heartedRequest
  const path = currentPath.value
  const count = settings.heartedCount
  // only where "Most played" lists videos and photos (.bin/<x>/<y>), not folders
  if (mostPlayedKind.value !== 'media' || count <= 0) return clearHearted()
  try {
    const list = await fetchHearted(path, Math.max(count, HEARTED_POOL))
    if (request !== heartedRequest || currentPath.value !== path) return
    hearted.value = list.slice(0, count)
    heartedPool = list.slice(count)
    heartedLoaded.value = true
    syncHeartedExtra()
  } catch (e) {
    console.warn(e)
  }
}

function clearHearted() {
  hearted.value = []
  heartedPool = []
  heartedLoaded.value = false
  media.setExtra([], heartedKey, 'hearted')
}

// a new count (Settings) shows right away
watch(() => settings.heartedCount, () => void loadHearted())

/** A full section swaps one random card for a random one it doesn't show */
function swapHearted() {
  if (heartedPool.length === 0 || hearted.value.length < settings.heartedCount) return
  // not while the tab is hidden, the viewer is open or in selection mode
  if (document.hidden || selected.value || selecting.value) return
  const slot = Math.floor(Math.random() * hearted.value.length)
  const from = Math.floor(Math.random() * heartedPool.length)
  const incoming = heartedPool[from]
  const outgoing = hearted.value[slot]
  if (!incoming || !outgoing) return
  heartedPool[from] = outgoing
  hearted.value[slot] = incoming
  syncHeartedExtra()
}

let heartedSwapTimer: ReturnType<typeof setInterval> | undefined

/** A heart was added / removed elsewhere (the grid's card): the section follows */
function syncHeartedWith(entry: Entry, on: boolean) {
  const prefix = currentPath.value ? `${currentPath.value}/` : ''
  if (mostPlayedKind.value !== 'media' || !heartedLoaded.value || !entry.path.startsWith(prefix)) {
    return
  }
  const shown = hearted.value.findIndex((e) => e.path === entry.path)
  if (!on) {
    heartedPool = heartedPool.filter((e) => e.path !== entry.path)
    if (shown >= 0) {
      const next = heartedPool.splice(Math.floor(Math.random() * heartedPool.length), 1)[0]
      if (next) hearted.value[shown] = next
      else hearted.value.splice(shown, 1)
    }
  } else if (shown < 0 && !heartedPool.some((e) => e.path === entry.path)) {
    if (hearted.value.length < settings.heartedCount) hearted.value.push({ ...entry })
    else heartedPool.push({ ...entry })
  }
  syncHeartedExtra()
}

// ── Switching the app mode: "Most played" grows in / shrinks away ──
// Only then: opening a folder or entering selection mode still shows / hides
// it at once, as before.

/** Longest wait for the section after a switch (its list loads first); after it, no animation */
const MODE_SWITCH_MAX_MS = 4000

/** The app mode was just switched: the section's next show / hide is animated */
const modeSwitching = ref(false)
let modeSwitchTimer: ReturnType<typeof setTimeout> | undefined
/** The section is playing its shrink-away */
let mostPlayedLeaving = false

function onMostPlayedLeaving() {
  mostPlayedLeaving = true
}

function onMostPlayedLeft() {
  mostPlayedLeaving = false
  modeSwitching.value = false
  // emptied now that it's gone (loadMostPlayed left it alone meanwhile)
  if (!recordsVideoData.value) clearMostPlayed()
}

// switching between dev and goon mode: the listing again, with or without the
// plays and "last viewed" (the server leaves them out in dev mode); reloading
// also fills or empties "Most played"
watch(recordsVideoData, () => {
  modeSwitching.value = true
  clearTimeout(modeSwitchTimer)
  modeSwitchTimer = setTimeout(() => (modeSwitching.value = false), MODE_SWITCH_MAX_MS)
  void reload()
})

// the listing in the order picked in Settings (Sorting → Sort by)
const sortedEntries = computed(() => sortEntries(entries.value, settings.sortBy))

/**
 * The open folder sits directly in .bin (ALPHABET_FOLDERS), like .bin/cinema:
 * not .bin itself, and not deeper (.bin/cinema/augustames). Leading dots and
 * case ignored, like the colored folder names
 */
const inAlphabetFolder = computed(() => {
  const parent = currentPath.value.split('/').at(-2)
  return parent !== undefined && ALPHABET_FOLDERS.includes(parent.replace(/^\.+/, '').toLowerCase())
})

// the alphabet bar: the letter of the first card on screen (only in
// inAlphabetFolder, and only when the page scrolls)
const { alphabet, scrollToLetter } = useAlphabetIndex(sortedEntries, () => inAlphabetFolder.value)

/**
 * Fixed columns (Settings → Grid → Columns): the top bar and the grid share a
 * centered column just wide enough for them; 0 leaves both full width
 */
const columnStyle = computed(() =>
  settings.gridColumns > 0
    ? {
        '--grid-columns': settings.gridColumns,
        // the "Most played" section fits one more card per row, in the same width
        '--most-played-columns': settings.gridColumns + 1,
        '--grid-column-width': `${GRID_COLUMN_WIDTH}px`,
      }
    : {},
)

/**
 * What the open folder holds directly (its subfolders' insides not counted),
 * and its total size (subfolders included: a folder entry's size is
 * everything inside it), for the top bar
 */
const folderStats = computed(() => {
  // hearts and views count everything inside, subfolders included (like the
  // size); views is null where the server doesn't record them (dev mode)
  const stats = { videos: 0, images: 0, folders: 0, size: 0, hearts: 0, views: null as number | null }
  for (const e of entries.value) {
    stats.size += e.size ?? 0
    stats.hearts += e.kind === 'folder' ? (e.favorite_count ?? 0) : e.favorite ? 1 : 0
    if (e.plays != null) stats.views = (stats.views ?? 0) + e.plays
    if (e.kind === 'video') stats.videos++
    else if (e.kind === 'image') stats.images++
    else if (e.kind === 'folder') stats.folders++
  }
  return stats
})

const { selected, show, close } = useLightbox()

/** What the lightbox's carousel goes through: the folder's photos and videos, in the grid's order */
const lightboxEntries = computed(() => sortedEntries.value.filter(isMediaEntry))

/**
 * The section shows (goon mode only; not in selection mode: picks belong to
 * the grid), with a placeholder while nothing here was played yet. Not in an
 * empty folder: its own message says enough
 */
const showMostPlayed = computed(
  () =>
    recordsVideoData.value &&
    mostPlayedLoaded.value &&
    entries.value.length > 0 &&
    !selecting.value,
)

const settingsOpen = ref(false)

// Grid previews pause while the lightbox is open so the opened video gets
// all the bandwidth and decoding power, and starts faster; the night sky
// pauses too, since the player covers it
let releaseBackground: (() => void) | null = null
watch(selected, (entry) => {
  media.setSuspended(entry !== null)
  if (entry && !releaseBackground) releaseBackground = holdBackgroundPause()
  if (!entry && releaseBackground) {
    releaseBackground()
    releaseBackground = null
  }
})

// ── Compressed copies ──
// The server compresses in the background (useCompressQueue). A copy saved
// into (or deleted from) the open folder, or one of its subfolders, shows
// at once: the listing loads again. A new copy wears the "Compressed!"
// banner (GalleryCard.vue) until it's opened in the viewer, on any device.

const stopCompressWatch = onCompressFolderChanged((folder) => {
  const open = currentPath.value
  if (folder === open || open === '' || folder.startsWith(`${open}/`)) void reload()
})

watch(selected, (entry) => {
  if (!entry?.compressed_new) return
  // every card of the file (grid, "Most played", "Hearted") loses it
  const copies = [entry, ...entries.value, ...mostPlayed.value, ...hearted.value, ...heartedPool].filter(
    (e) => e.path === entry.path,
  )
  for (const e of copies) e.compressed_new = false
  markCompressedSeen(entry.path).catch((e: unknown) => {
    for (const c of copies) c.compressed_new = true
    console.warn(e)
  })
})

// ── Selection mode ──
// Turned on from the Select row of a file's menu (FileMenu.vue): tapping a
// file picks it instead of opening it, and the bar at the bottom moves or
// trashes the picked ones together (SelectionBar.vue).
const selecting = ref(false)
/** Paths of the picked files (of the open folder only) */
const picked = reactive(new Set<string>())

const pickedEntries = computed(() => sortedEntries.value.filter((e) => picked.has(e.path)))
const selectableCount = computed(() => entries.value.filter((e) => e.kind !== 'folder').length)

function toggleSelecting() {
  selecting.value = !selecting.value
  picked.clear()
}

provide(SELECTION_KEY, {
  active: readonly(selecting),
  // the file whose menu it came from starts picked
  start(path: string) {
    if (!selecting.value) toggleSelecting()
    picked.add(path)
  },
})

function togglePicked(entry: Entry) {
  if (picked.has(entry.path)) picked.delete(entry.path)
  else picked.add(entry.path)
}

function pickAll() {
  for (const e of entries.value) if (e.kind !== 'folder') picked.add(e.path)
}

/** Files were moved or trashed: they're gone from here, so is their pick */
function onSelectionChanged() {
  picked.clear()
  refresh()
}

// files that left the listing (moved, deleted elsewhere) can't stay picked
watch(entries, (list) => {
  const present = new Set(list.map((e) => e.path))
  for (const path of picked) if (!present.has(path)) picked.delete(path)
})

// nothing left to pick here (only folders, or empty): selection mode ends
watch(selectableCount, (count) => {
  if (count === 0 && selecting.value) toggleSelecting()
})

// Escape leaves selection mode (unless a dialog is open: Escape closes that)
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && selecting.value && !backgroundPaused.value) toggleSelecting()
}

/** Opens a folder; a selection belongs to one folder, so it's dropped */
function goTo(path: string) {
  picked.clear()
  navigate(path)
}

function open(entry: Entry) {
  haptic('tap')
  if (entry.kind === 'folder') goTo(entry.path)
  else if (selecting.value) togglePicked(entry)
  else show(entry)
}

/**
 * A card of the "Most played" section isn't opened there: it leads to its own
 * card in the grid of the folder it's in (a folder: in this grid; a video or
 * photo: that folder opens first if it's a subfolder)
 */
async function openFromMostPlayed(entry: Entry) {
  haptic('tap')
  const folder = entry.path.split('/').slice(0, -1).join('/')
  const navigated = folder !== currentPath.value
  if (navigated) {
    picked.clear()
    await navigate(folder)
  }
  await nextTick()
  await revealCard(entry.path, navigated)
}

/** Longest the smooth scroll to a revealed card is waited for (no scroll needed: no scrollend) */
const REVEAL_SCROLL_WAIT_MS = 900

/** Resolves when the page stops scrolling, or after `maxMs` at most */
function scrollSettled(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener('scrollend', done)
      resolve()
    }
    const timer = setTimeout(done, maxMs)
    window.addEventListener('scrollend', done, { once: true })
  })
}

/** The card being revealed now (revealCard): its GalleryCard plays the loaded sweep */
const revealingPath = ref<string | null>(null)
let revealTimer: ReturnType<typeof setTimeout> | undefined

/** Longest wait for a card to be drawn, and for its place to stop moving (ms) */
const REVEAL_LAYOUT_WAIT_MS = 1500
/** Frames in a row a card must stay put to count as placed */
const REVEAL_STILL_FRAMES = 3

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** Selects the grid's card of `path` (not its copy in the "Most played" section) */
const cardSelector = (path: string) => `.main-grid > .card[data-path="${CSS.escape(path)}"]`

/** The grid's card of `path`, once drawn; null if it never is */
async function findCard(path: string): Promise<HTMLElement | null> {
  const selector = cardSelector(path)
  const until = performance.now() + REVEAL_LAYOUT_WAIT_MS
  for (;;) {
    const card = document.querySelector<HTMLElement>(selector)
    if (card || performance.now() > until) return card
    await nextFrame()
  }
}

/**
 * Resolves once `card` stays in the same place on the page for a few frames:
 * a folder just opened is still laying out (each card measures itself for the
 * masonry grid after it's drawn), and scrolling before that ends up elsewhere
 */
async function cardPlaced(card: HTMLElement) {
  const until = performance.now() + REVEAL_LAYOUT_WAIT_MS
  let last = Number.NaN
  let still = 0
  while (still < REVEAL_STILL_FRAMES && performance.now() < until) {
    await nextFrame()
    const top = card.getBoundingClientRect().top + window.scrollY
    still = Math.abs(top - last) < 1 ? still + 1 : 0
    last = top
  }
}

/** Only the latest reveal goes on (a second tap starts over) */
let revealRun = 0

/**
 * Scrolls the grid's card of `path` into the middle of the screen and, once
 * it's there, has it play the same sweep as a preview that just loaded
 * (GalleryCard.vue, the `revealing` watcher). In a folder just opened
 * (`afterNavigation`) it waits for the card to be drawn and placed first,
 * since the grid is still laying out; in one that's been on screen it goes
 * at once. If it moved while scrolling (pictures above it loaded), it's
 * brought back to the middle. False if the grid has no such card
 */
async function revealCard(path: string, afterNavigation = true): Promise<boolean> {
  const run = ++revealRun
  const card = await findCard(path)
  if (!card || run !== revealRun) return false
  if (afterNavigation) await cardPlaced(card)
  if (run !== revealRun || !card.isConnected) return false
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await scrollSettled(REVEAL_SCROLL_WAIT_MS)
  if (run !== revealRun || !card.isConnected) return false
  const rect = card.getBoundingClientRect()
  const middle = rect.top + rect.height / 2
  if (middle < window.innerHeight * 0.2 || middle > window.innerHeight * 0.8) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await scrollSettled(REVEAL_SCROLL_WAIT_MS)
  }
  // the same card again: play its sweep again
  revealingPath.value = null
  await nextTick()
  revealingPath.value = path
  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => (revealingPath.value = null), REVEAL_MS)
  return true
}

/**
 * Hearts or un-hearts a file: shown right away (and re-sorted, if sorting by
 * favorites), then saved on the server; put back if saving fails
 */
/**
 * A video started playing in the viewer, or a photo loaded there: saved on the
 * server as viewed (it and every folder above it) and counted as a play, and
 * shown in its menu right away, on both its cards (grid and "Most played").
 * Once the server has counted it, "Most played" loads again, so its counts,
 * its order and what's in it (a video that just made it in, a folder's new
 * total) are up to date under the viewer. The carousel goes by the grid, not
 * by the section, so it doesn't move. The grid's folder cards follow when the
 * folder loads again.
 */
async function onViewed(entry: Entry) {
  // dev mode: nothing is recorded (src/appMode.ts)
  if (!recordsVideoData.value) return
  const copies = [entry, ...entries.value, ...mostPlayed.value, ...hearted.value, ...heartedPool].filter(
    (e) => e.path === entry.path,
  )
  const set = (viewed: number, plays: number) => {
    for (const e of copies) {
      e.last_viewed = viewed
      e.plays = plays
    }
  }
  set(Date.now(), (entry.plays ?? 0) + 1)
  try {
    const result = await markViewed(entry.path)
    // null: the server didn't record it (switched to dev mode meanwhile)
    if (result.viewed !== null && result.plays !== null) {
      set(result.viewed, result.plays)
      void loadMostPlayed()
    }
  } catch (e) {
    console.warn(e)
  }
}

async function toggleFavorite(entry: Entry, on: boolean) {
  // the same file can have a card in the grid, "Most played" and "Hearted": all change
  const copies = [entry, ...entries.value, ...mostPlayed.value, ...hearted.value, ...heartedPool].filter(
    (e) => e.path === entry.path,
  )
  for (const e of copies) e.favorite = on
  syncHeartedWith(entry, on)
  try {
    await setFavorite(entry.path, on)
  } catch (e) {
    for (const c of copies) c.favorite = !on
    syncHeartedWith(entry, !on)
    console.warn(e)
  }
}

/** Lists the current folder again after a file was moved out of it, deleted, or uploaded into a subfolder */
function refresh() {
  reload()
}

// for actions that wait until their result shows in the grid (Fix TS):
// resolves after the new listing is fetched and the grid has drawn it
provide(RELOAD_GALLERY_KEY, async () => {
  await reload()
  await nextTick()
})

// a folder was just created, a copy saved, a compression tapped in its popup:
// show where it is in the grid (`openFolder`: its folder opens first)
async function revealEntry(path: string, openFolder = false) {
  const folder = path.split('/').slice(0, -1).join('/')
  /** A new folder's listing is still laying out: its cards get measured after they're drawn */
  let navigated = false
  if (openFolder && folder !== currentPath.value) {
    picked.clear()
    if (selecting.value) toggleSelecting()
    await navigate(folder) // lists the folder it opens
    navigated = true
  } else if (!document.querySelector(cardSelector(path))) {
    // its card isn't in the grid yet (a file or folder that was just made): list again.
    // Already there: no need, which saves a trip to the server (it probes every video again)
    await reload()
  }
  await nextTick()
  await revealCard(path, navigated) // not there if it was made inside a subfolder: nothing to show
}
provide(REVEAL_ENTRY_KEY, revealEntry)
// the same for code outside these components (the compress popup)
const stopRevealHandler = setRevealHandler(revealEntry)

async function shutdown() {
  if (!confirm(SHUTDOWN_CONFIRM)) return
  // the screen turns off like an old TV, then the server stops
  await playPowerOff()
  await shutdownServer()
  window.close()
}

// ── Coming back after a lock ──
// Locking notes the open folder, how far down it was, and what the viewer
// showed (useResume); unlocking mounts App again and returns there. The
// viewer and player put back their own parts (fullscreen, the video's time)
onCaptureResume(() => ({
  path: currentPath.value,
  scrollY: window.scrollY,
  open: selected.value?.path ?? null,
}))

async function start() {
  const resume = takeResumePoint()
  await init(resume?.path ?? '')
  if (!resume) return
  // the grid is drawn: scroll back to where it was, then reopen the viewer
  await nextTick()
  window.scrollTo({ top: resume.scrollY, behavior: 'instant' })
  if (!resume.open) return
  const open = lightboxEntries.value.find((e) => e.path === resume.open)
  if (open) show(open)
  // gone meanwhile (moved, deleted): drop the viewer's part too
  else takeViewerResume(resume.open)
}

onMounted(() => {
  // shared settings (sort, player, look…) from the server; until they arrive,
  // this browser's copy of them is used
  void loadSharedSettings()
  void start()
  window.addEventListener('keydown', onKeydown)
  heartedSwapTimer = setInterval(swapHearted, HEARTED_SWAP_MS)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(revealTimer)
  clearInterval(heartedSwapTimer)
  stopCompressWatch()
  stopRevealHandler()
})
</script>

<template>
  <div class="gallery" :class="{ selecting }">
    <!-- the night sky, behind everything else -->
    <NightSky />

    <!-- top bar and cards: full width, or a centered column with fixed columns -->
    <div
      class="column"
      :class="{ fixed: settings.gridColumns > 0, single: settings.gridColumns === 1 }"
      :style="columnStyle"
    >
    <BreadcrumbBar
      :root-name="rootFolderName"
      :crumbs="breadcrumbs"
      :stats="folderStats"
      :alphabet="alphabet"
      @letter="scrollToLetter"
      @navigate="goTo"
      @settings="settingsOpen = true"
      @shutdown="shutdown"
      @changed="refresh"
      @renamed="goTo"
    />

    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />

    <div v-if="entries.length === 0" class="empty">
      <span class="empty-icon">📭</span>
      <p>{{ EMPTY_FOLDER_TEXT }}</p>
    </div>

    <!-- the most played videos and photos of this folder and its subfolders.
         Switching the app mode makes it grow in / shrink away (no-anim: at once) -->
    <Transition
      :name="modeSwitching ? 'mode-section' : 'no-anim'"
      @before-leave="onMostPlayedLeaving"
      @after-leave="onMostPlayedLeft"
      @after-enter="modeSwitching = false"
    >
      <section v-if="showMostPlayed" class="most-played">
        <div class="most-played-inner">
          <h2 class="section-title">{{ MOST_PLAYED_TITLE }}</h2>
          <p v-if="mostPlayed.length === 0" class="most-played-empty">
            {{ MOST_PLAYED_EMPTY_TEXT }}
          </p>
          <div v-else class="grid">
            <GalleryCard
              v-for="entry in mostPlayed"
              :key="mostPlayedKey(entry)"
              :status-key="mostPlayedKey(entry)"
              :entry="entry"
              :selecting="false"
              :selected="false"
              link-only
              views-only
              @open="openFromMostPlayed"
              @favorite="toggleFavorite"
              @changed="refresh"
            />
          </div>

          <!-- random hearted videos and photos of this folder and its subfolders -->
          <template v-if="heartedLoaded && settings.heartedCount > 0">
            <h2 class="section-title">{{ HEARTED_TITLE }}</h2>
            <p v-if="hearted.length === 0" class="most-played-empty">
              {{ HEARTED_EMPTY_TEXT }}
            </p>
            <div v-else class="grid hearted">
              <!-- one slot per position: a swap shrinks the old card away, then
                   grows the new one in its place (no wrapper: the cards stay
                   the masonry grid's items) -->
              <template v-for="(entry, i) in hearted" :key="i">
                <Transition name="hearted-swap" mode="out-in">
                  <GalleryCard
                    :key="heartedKey(entry)"
                    :status-key="heartedKey(entry)"
                    :entry="entry"
                    :selecting="false"
                    :selected="false"
                    link-only
                    bare
                    @open="openFromMostPlayed"
                    @favorite="toggleFavorite"
                    @changed="refresh"
                  />
                </Transition>
              </template>
            </div>
          </template>

          <h2 class="section-title">All</h2>
        </div>
      </section>
    </Transition>

    <div class="grid main-grid">
      <GalleryCard
        v-for="entry in sortedEntries"
        :key="entry.path"
        :entry="entry"
        :selecting="selecting"
        :selected="picked.has(entry.path)"
        :revealing="revealingPath === entry.path"
        @open="open"
        @favorite="toggleFavorite"
        @changed="refresh"
      />
    </div>
    </div>

    <SelectionBar
      v-if="selecting"
      :selected="pickedEntries"
      :selectable="selectableCount"
      @select-all="pickAll"
      @select-none="picked.clear()"
      @done="selecting && toggleSelecting()"
      @changed="onSelectionChanged"
    />

    <MediaLightbox
      :entry="selected"
      :entries="lightboxEntries"
      @close="close"
      @select="show"
      @viewed="onViewed"
    />
  </div>
</template>

<style scoped>
/* The night sky (sky, nebula clouds, stars) is drawn by NightSky.vue on a
   fixed canvas behind everything; this color only shows before it draws */
.gallery {
  position: relative;
  isolation: isolate; /* keeps the sky canvas behind the content */
  min-height: 100dvh;
  background: var(--page-bg);
  color: #e8e8e8;
  padding: 1rem;
  /* the sky goes under the phone's gesture bar; the last cards scroll above it */
  padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
}

/* room under the last cards for the selection bar (three rows, SelectionBar.vue) */
.gallery.selecting {
  padding-bottom: calc(10rem + env(safe-area-inset-bottom, 0px));
}

/* ── Grid ── */
/* The ring (styles/ring.css) and the glass border (GalleryCard.vue) are drawn
   outside each card, so the gap and padding grow with --card-outset (tokens.css)
   to keep them from overlapping each other or the edges */
/* Masonry: portrait photos / videos are taller than the square cards
   (GalleryCard.vue), and each column stacks its cards with no holes under
   the shorter ones. The rows are 1px tall and every card spans as many as
   it is tall, plus the gap under it (GalleryCard measures itself and sets
   grid-row-end). Placed in order, each card drops into the column that
   frees up first, so the order still reads left to right, top to bottom.
   The gap between cards is therefore the column gap, and the cards' own
   span below; there's no row gap */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  grid-auto-rows: 1px;
  column-gap: calc(var(--grid-gap) + 2 * var(--card-outset));
  padding: var(--card-outset);
  /* each card keeps its own height instead of filling its rows */
  align-items: start;
}

@media (max-width: 480px) {
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    column-gap: calc(0.75 * var(--grid-gap) + 2 * var(--card-outset));
  }
}

@media (min-width: 1200px) {
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }
}

/* Fixed columns (Settings → Grid → Columns): exactly that many, each up to
   --grid-column-width, and the top bar as wide as the grid, both centered.
   On a narrow screen the column simply fills it */
.column.fixed {
  --column-gap: calc(var(--grid-gap) + 2 * var(--card-outset));
  max-width: calc(
    var(--grid-columns) * var(--grid-column-width) + (var(--grid-columns) - 1) *
      var(--column-gap) + 2 * var(--card-outset)
  );
  margin-inline: auto;
}

.column.fixed .grid {
  grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
}

/* one column: the cards and the top bar fill the screen's width (inside the
   page's padding) instead of stopping at --grid-column-width */
.column.fixed.single {
  max-width: none;
}

@media (max-width: 480px) {
  .column.fixed {
    --column-gap: calc(0.75 * var(--grid-gap) + 2 * var(--card-outset));
  }
}

/* ── Most played ── */
/* a one-row grid around its content, so switching the app mode can shrink the
   row to nothing (grid-template-rows animates; height: auto doesn't) */
.most-played {
  display: grid;
  grid-template-rows: 1fr;
  margin-bottom: 0.5rem;
}

.most-played-inner {
  min-height: 0;
}

/* switching the app mode: grows in from nothing and fades in, or the reverse;
   the grid below slides along. Clipped only meanwhile (the cards' hover and
   glow reach past the section otherwise) */
.mode-section-enter-active,
.mode-section-leave-active {
  transition:
    grid-template-rows 0.42s cubic-bezier(0.2, 0.8, 0.2, 1),
    margin-bottom 0.42s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.3s ease;
}

.mode-section-enter-active .most-played-inner,
.mode-section-leave-active .most-played-inner {
  overflow: hidden;
}

.mode-section-enter-from,
.mode-section-leave-to {
  grid-template-rows: 0fr;
  margin-bottom: 0;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .mode-section-enter-active,
  .mode-section-leave-active {
    transition: opacity 0.2s;
  }

  .mode-section-enter-from,
  .mode-section-leave-to {
    grid-template-rows: 1fr;
    margin-bottom: 0.5rem;
  }
}

.section-title {
  margin: 0.25rem 0 0.75rem;
  padding-inline: var(--card-outset);
  color: #cfc8e8;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.most-played .grid {
  margin-bottom: 1rem;
}

/* nothing played here yet: a quiet line where the cards would be */
.most-played-empty {
  margin: 0 0 1rem;
  padding: 1rem var(--card-outset);
  color: #8f88aa;
  font-size: 0.85rem;
  text-align: center;
  border: 1px dashed rgba(207, 200, 232, 0.18);
  border-radius: var(--video-radius);
}

/* one more card per row than the grid below (Settings → Grid → Columns),
   so its cards are a bit smaller. As many as fit: smaller minimum widths */
.most-played .grid {
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
}

@media (max-width: 480px) {
  .most-played .grid {
    grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
  }
}

@media (min-width: 1200px) {
  .most-played .grid {
    grid-template-columns: repeat(auto-fill, minmax(224px, 1fr));
  }
}

.column.fixed .most-played .grid {
  grid-template-columns: repeat(var(--most-played-columns), minmax(0, 1fr));
}

/* ── Hearted: the swap ── */
/* the card's root gets App's scope attribute too, so these beat GalleryCard's
   own `.card { transition: transform 0.15s }`. Scaling doesn't change the
   layout, so the grid around the slot stays put */
.hearted .card.hearted-swap-leave-active {
  transition:
    transform 0.28s cubic-bezier(0.5, 0, 0.9, 0.4),
    opacity 0.28s ease-in;
}

.hearted .card.hearted-swap-enter-active {
  transition:
    transform 0.38s cubic-bezier(0.2, 0.9, 0.3, 1.25),
    opacity 0.25s ease-out;
}

.hearted .card.hearted-swap-leave-to,
.hearted .card.hearted-swap-enter-from {
  transform: scale(0);
  opacity: 0;
}

/* reduced motion: only a fade */
@media (prefers-reduced-motion: reduce) {
  .hearted .card.hearted-swap-leave-to,
  .hearted .card.hearted-swap-enter-from {
    transform: none;
  }
}

/* ── Empty state ── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 5rem 0;
  color: #555;
}

.empty-icon {
  font-size: 3rem;
}
</style>
