<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { fileUrl, queueEdit, renameEntry, setPlays } from '@/api'
import { recordsVideoData } from '@/appMode'
import { pulseCompress } from '@/composables/useCompressQueue'
import { PROMO_OUTROS, type PromoOutro } from '@/constants'
import type { Entry } from '@/types'
import { formatSize } from '@/utils/format'

/**
 * Edits a video or photo:
 * - its name and its views (how many times it was played / shown, on every
 *   device): changed on the file itself
 * - cut off the video's start and/or end (yellow handles, like Photos on the
 *   iPhone) and crop the edges of either (the white frame): added to the
 *   server's compress queue, which saves the copy next to it in the
 *   background, "<name>_edited.<ext>" (videos always .mp4; JPEGs cropped
 *   losslessly; server/media/editMedia.ts), with fixed settings that keep it
 *   looking like the original. Its progress is in the top bar's queue button
 *   (CompressButton.vue), like a compression's. The original is never touched.
 * Save does them in that order, so the copy is named after the new name.
 */
const props = defineProps<{ entry: Entry }>()
/** `changed`: the name or views were saved, so the listing should be reloaded */
const emit = defineEmits<{ close: []; changed: [] }>()

const isVideo = props.entry.kind === 'video'
const src = fileUrl(props.entry.path)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const pct = (f: number) => `${f * 100}%`

const saving = ref(false)

// ── Name and views (changed on the file itself) ──

/** Where the file is and what it's called now (they change once a rename is saved) */
let savedPath = props.entry.path
const savedName = ref(props.entry.name)
const savedViews = ref(props.entry.plays ?? 0)

const newName = ref(props.entry.name)
const views = ref<number | ''>(props.entry.plays ?? 0)

/** Caught here so it shows while typing; the server checks again */
const nameProblem = computed(() => {
  const n = newName.value.trim()
  if (!n) return 'Enter a name'
  if (/[/\\]/.test(n)) return "A name can't contain / or \\"
  return null
})
const viewsProblem = computed(() =>
  typeof views.value === 'number' && Number.isInteger(views.value) && views.value >= 0
    ? null
    : 'Views must be a whole number, 0 or more',
)
const renamed = computed(() => newName.value.trim() !== savedName.value)
const viewsChanged = computed(
  () => typeof views.value === 'number' && views.value !== savedViews.value,
)

// ── Crop: fractions (0–1) of the picture as shown ──

/** Smallest crop, as a fraction of each side */
const MIN_CROP = 0.05
const crop = reactive({ x: 0, y: 0, w: 1, h: 1 })

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']

const frame = ref<HTMLElement | null>(null)
let cropDrag: {
  handle: Handle
  px: number
  py: number
  from: { x: number; y: number; w: number; h: number }
  rect: DOMRect
} | null = null

function startCrop(e: PointerEvent, handle: Handle) {
  if (!frame.value || saving.value) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  cropDrag = {
    handle,
    px: e.clientX,
    py: e.clientY,
    from: { ...crop },
    rect: frame.value.getBoundingClientRect(),
  }
}

/** The handles' moves bubble up to the crop box, so this one listener sees them all */
function moveCrop(e: PointerEvent) {
  if (!cropDrag) return
  const { handle, from, rect } = cropDrag
  const dx = (e.clientX - cropDrag.px) / rect.width
  const dy = (e.clientY - cropDrag.py) / rect.height
  if (handle === 'move') {
    crop.x = clamp(from.x + dx, 0, 1 - from.w)
    crop.y = clamp(from.y + dy, 0, 1 - from.h)
    return
  }
  let left = from.x
  let top = from.y
  let right = from.x + from.w
  let bottom = from.y + from.h
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP)
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1)
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP)
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1)
  Object.assign(crop, { x: left, y: top, w: right - left, h: bottom - top })
}

function endCrop() {
  cropDrag = null
}

/** Size of the picture as shown, to show the crop in pixels */
const natural = reactive({ w: 0, h: 0 })
const cropPixels = computed(() =>
  natural.w ? `${Math.round(crop.w * natural.w)} × ${Math.round(crop.h * natural.h)}` : '',
)

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  natural.w = img.naturalWidth
  natural.h = img.naturalHeight
}

// ── Trim (videos) ──

/** Shortest part that can be kept, in seconds */
const MIN_LENGTH = 0.1
const video = ref<HTMLVideoElement | null>(null)
const track = ref<HTMLElement | null>(null)
const duration = ref(0)
const trim = reactive({ start: 0, end: 0 })
const current = ref(0)
const playing = ref(false)
/** Starts without sound, like the viewer's player; only the button turns it on */
const muted = ref(true)
let trimming: 'start' | 'end' | null = null

function toggleMute() {
  const v = video.value
  if (!v) return
  v.muted = !v.muted
  muted.value = v.muted
}

const frac = (t: number) => (duration.value ? t / duration.value : 0)

function onMeta() {
  const v = video.value
  if (!v) return
  duration.value = Number.isFinite(v.duration) ? v.duration : (props.entry.duration ?? 0)
  trim.start = 0
  trim.end = duration.value
  natural.w = v.videoWidth
  natural.h = v.videoHeight
}

function seek(t: number) {
  current.value = t
  if (video.value) video.value.currentTime = t
}

function timeAt(e: PointerEvent): number {
  const r = track.value!.getBoundingClientRect()
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration.value
}

function startTrim(e: PointerEvent, which: 'start' | 'end') {
  if (saving.value) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  trimming = which
  video.value?.pause()
}

/** The grips' moves bubble up to the track, so this one listener sees them both */
function moveTrim(e: PointerEvent) {
  if (!trimming) return
  const t = timeAt(e)
  if (trimming === 'start') trim.start = clamp(t, 0, trim.end - MIN_LENGTH)
  else {
    trim.end = clamp(t, trim.start + MIN_LENGTH, duration.value)
    // the end was moved by hand: no longer an app's outro cut off
    promo.value = null
  }
  // show the frame the cut lands on
  seek(trimming === 'start' ? trim.start : trim.end)
}

function endTrim() {
  trimming = null
}

/** A tap on the bar jumps there (inside the part kept) */
function seekTrack(e: PointerEvent) {
  if (!trimming && !saving.value) seek(clamp(timeAt(e), trim.start, trim.end))
}

/** Plays only the part kept, stopping at its end */
function onTime() {
  const v = video.value
  if (!v) return
  current.value = v.currentTime
  if (!v.paused && v.currentTime >= trim.end) {
    v.pause()
    seek(trim.start)
  }
}

function togglePlay() {
  const v = video.value
  if (!v) return
  if (!v.paused) return v.pause()
  if (v.currentTime < trim.start || v.currentTime >= trim.end - 0.05) seek(trim.start)
  void v.play()
}

// ── Trim an app's outro (videos) ──

/** The app whose logo outro is cut off the end (PROMO_OUTROS), if one is picked */
const promo = ref<PromoOutro | null>(null)
const PROMO_KEYS = Object.keys(PROMO_OUTROS) as PromoOutro[]

/** What the "Trim" row says it does: "TikTok 4 s, Instagram 4 s" */
const promoSummary = PROMO_KEYS.map((k) => `${PROMO_OUTROS[k].label} ${PROMO_OUTROS[k].secs} s`).join(
  ', ',
)

/** The video is long enough for that outro to be cut off and something kept */
function promoFits(key: PromoOutro): boolean {
  return duration.value - PROMO_OUTROS[key].secs >= trim.start + MIN_LENGTH
}

/**
 * Picks the app: the end of the part kept moves to its outro's start (the
 * trim bar shows it, and the frame there is shown). Picking it again puts the
 * end back where the video ends
 */
function pickPromo(key: PromoOutro) {
  if (saving.value) return
  video.value?.pause()
  if (promo.value === key) {
    promo.value = null
    trim.end = duration.value
  } else {
    if (!promoFits(key)) return
    promo.value = key
    trim.end = duration.value - PROMO_OUTROS[key].secs
  }
  seek(trim.end)
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

// ── Saving ──

const cropped = computed(
  () => crop.x > 0.001 || crop.y > 0.001 || crop.w < 0.999 || crop.h < 0.999,
)
const trimmed = computed(
  () => isVideo && (trim.start > 0.05 || trim.end < duration.value - 0.05),
)
/** A copy is made (trim / crop) */
const makesCopy = computed(() => cropped.value || trimmed.value)
const hasChanges = computed(() => makesCopy.value || renamed.value || viewsChanged.value)
const canSave = computed(
  () => hasChanges.value && !nameProblem.value && !viewsProblem.value && !saving.value,
)

const error = ref('')

/**
 * Compress the edited copy too, right after it's made (one job in the queue,
 * like Compress in a file's menu); only the compressed one is kept, unless it
 * wouldn't get smaller
 */
const compressAfter = ref(false)

function reset() {
  Object.assign(crop, { x: 0, y: 0, w: 1, h: 1 })
  promo.value = null
  trim.start = 0
  trim.end = duration.value
  newName.value = savedName.value
  views.value = savedViews.value
}

/** The name or views were saved on the server: the folder is listed again when the dialog closes */
let anythingSaved = false

/**
 * Renames it, sets its views, then adds the trimmed / cropped copy (named
 * after the new name) to the queue, as far as each changed, and closes. A
 * step that fails stops there: the ones before stay saved, and Save tries the
 * rest again. The copy shows up in the folder once the queue has made it
 * (App reloads the folder), with the "Edited!" banner.
 */
async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  video.value?.pause()
  try {
    if (renamed.value) {
      savedPath = await renameEntry(savedPath, newName.value.trim())
      savedName.value = newName.value.trim()
      anythingSaved = true
    }
    if (viewsChanged.value && typeof views.value === 'number') {
      await setPlays(savedPath, views.value)
      savedViews.value = views.value
      anythingSaved = true
    }
    if (makesCopy.value) {
      // the haptic tap and the top bar's pulse right away, as for Compress
      pulseCompress()
      // a photo has nothing to trim
      const { start, end } = isVideo ? trim : { start: 0, end: 0 }
      await queueEdit(savedPath, { start, end, ...crop }, compressAfter.value)
    }
    close()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Saving failed'
  } finally {
    saving.value = false
  }
}

/** Closes; if the name or views were saved, the folder is listed again */
function close() {
  if (anythingSaved) emit('changed')
  emit('close')
}

/** Leaving or reloading the page mid-save could lose the rest of it: ask first */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (saving.value) e.preventDefault()
}

window.addEventListener('beforeunload', onBeforeUnload)
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))
</script>

<template>
  <ModalDialog
    large
    :title="`Edit ${entry.name}`"
    :subtitle="cropPixels"
    :locked="saving"
    @close="close"
  >
    <!-- the file itself: its name and views -->
    <div class="info">
      <label class="field name-field">
        <span class="field-label">Name</span>
        <input
          v-model="newName"
          class="field-input"
          type="text"
          maxlength="255"
          autocomplete="off"
          enterkeyhint="done"
          :disabled="saving"
          @keydown.enter.prevent="save"
        />
      </label>
      <!-- dev mode: views aren't shown or changed (src/appMode.ts) -->
      <label v-if="recordsVideoData" class="field views-field">
        <span class="field-label">Views</span>
        <input
          v-model.number="views"
          class="field-input"
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          enterkeyhint="done"
          :disabled="saving"
          @keydown.enter.prevent="save"
        />
      </label>
    </div>
    <p v-if="renamed && nameProblem" class="error">{{ nameProblem }}</p>
    <p v-if="viewsProblem" class="error">{{ viewsProblem }}</p>

    <div class="stage">
      <div ref="frame" class="frame">
        <video
          v-if="isVideo"
          ref="video"
          class="media"
          :src="src"
          muted
          playsinline
          preload="auto"
          @loadedmetadata="onMeta"
          @volumechange="muted = video?.muted ?? true"
          @timeupdate="onTime"
          @play="playing = true"
          @pause="playing = false"
        />
        <img v-else class="media" :src="src" alt="" draggable="false" @load="onImageLoad" />

        <div
          class="crop"
          :style="{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }"
          @pointerdown="startCrop($event, 'move')"
          @pointermove="moveCrop"
          @pointerup="endCrop"
          @pointercancel="endCrop"
        >
          <span
            v-for="h in HANDLES"
            :key="h"
            class="handle"
            :class="h"
            @pointerdown.stop="startCrop($event, h)"
          />
        </div>
      </div>
    </div>

    <template v-if="isVideo">
      <div class="trim">
        <button
          class="play"
          :aria-label="playing ? 'Pause' : 'Play'"
          :disabled="saving"
          @click="togglePlay"
        >
          {{ playing ? '❚❚' : '▶' }}
        </button>
        <button class="play" :aria-label="muted ? 'Unmute' : 'Mute'" @click="toggleMute">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              v-if="muted"
              d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"
            />
            <path
              v-else
              d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
            />
          </svg>
        </button>
        <div
          ref="track"
          class="track"
          @pointerdown="seekTrack"
          @pointermove="moveTrim"
          @pointerup="endTrim"
          @pointercancel="endTrim"
        >
          <div
            class="kept"
            :style="{ left: pct(frac(trim.start)), width: pct(frac(trim.end - trim.start)) }"
          >
            <span class="grip start" @pointerdown.stop="startTrim($event, 'start')" />
            <span class="grip end" @pointerdown.stop="startTrim($event, 'end')" />
          </div>
          <div class="playhead" :style="{ left: pct(frac(current)) }" />
        </div>
      </div>
      <div class="times">
        <span>{{ formatTime(trim.start) }}</span>
        <span>{{ formatTime(trim.end - trim.start) }} kept</span>
        <span>{{ formatTime(trim.end) }}</span>
      </div>

      <!-- cut off the logo outro an app adds to its downloads: moves the end
           of the part kept (the yellow handle) back by that many seconds -->
      <div class="promo">
        <span class="check-text">
          <span class="check-title">Trim</span>
          <small>The app's logo outro at the end of a downloaded video ({{ promoSummary }})</small>
        </span>
        <div class="promo-options" role="group" aria-label="Trim the outro of">
          <button
            v-for="key in PROMO_KEYS"
            :key="key"
            type="button"
            class="promo-option"
            :class="{ active: promo === key }"
            :aria-pressed="promo === key"
            :disabled="saving || (promo !== key && !promoFits(key))"
            :title="`Cut the last ${PROMO_OUTROS[key].secs} s (${PROMO_OUTROS[key].label}'s outro)`"
            @click="pickPromo(key)"
          >
            {{ PROMO_OUTROS[key].label }}
          </button>
        </div>
      </div>
    </template>

    <!-- only means something once there's a copy to make (trim / crop) -->
    <label class="check" :class="{ off: !makesCopy }">
      <input v-model="compressAfter" type="checkbox" :disabled="saving || !makesCopy" />
      <span class="box" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
      </span>
      <span class="check-text">
        <span class="check-title">
          Compress it too
          <!-- the size of the file being edited, as it is now -->
          <span v-if="entry.size" class="check-size">{{ formatSize(entry.size) }}</span>
        </span>
        <small>Once the copy is made, like Compress does; only the compressed one is kept</small>
      </span>
    </label>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else class="hint">
      The name and views change this file. Trimming or cropping saves a new file ending in
      “_edited” next to it, in the background (its progress is in the top bar), so this file
      stays as it is.
    </p>

    <div class="actions">
      <button class="button" :disabled="saving || !hasChanges" @click="reset">Reset</button>
      <span class="spacer" />
      <button class="button" :disabled="saving" @click="close">Cancel</button>
      <button class="button primary" :disabled="!canSave" @click="save">
        {{ saving ? 'Saving…' : makesCopy && !renamed && !viewsChanged ? 'Save copy' : 'Save' }}
      </button>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* ── Name and views ── */
.info {
  display: flex;
  gap: 0.6rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.name-field {
  flex: 1;
  min-width: 0;
}

.views-field {
  flex: none;
  width: 7rem;
}

.field-label {
  color: #aaa;
  font-size: 0.75rem;
}

.field-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.35);
  color: #eee;
  /* 16px+: iOS zooms the page into smaller inputs */
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color 0.12s;
}

.field-input:focus {
  border-color: #2d6cdf;
}

/* ── Picture and crop frame ── */
.stage {
  display: flex;
  justify-content: center;
}

.frame {
  position: relative;
  /* keeps the dimming inside the picture */
  overflow: hidden;
  line-height: 0;
  user-select: none;
}

.media {
  display: block;
  max-width: 100%;
  max-height: 55dvh;
}

.crop {
  position: absolute;
  outline: 1px solid rgba(255, 255, 255, 0.9);
  /* everything outside the frame is dimmed */
  box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.55);
  cursor: move;
  touch-action: none;
}

.handle {
  position: absolute;
  touch-action: none;
}

/* corners: white L shapes */
.handle.nw,
.handle.ne,
.handle.sw,
.handle.se {
  width: 1.4rem;
  height: 1.4rem;
  border: 0 solid #fff;
}

.handle.nw {
  left: 0;
  top: 0;
  border-left-width: 3px;
  border-top-width: 3px;
  cursor: nwse-resize;
}

.handle.ne {
  right: 0;
  top: 0;
  border-right-width: 3px;
  border-top-width: 3px;
  cursor: nesw-resize;
}

.handle.sw {
  left: 0;
  bottom: 0;
  border-left-width: 3px;
  border-bottom-width: 3px;
  cursor: nesw-resize;
}

.handle.se {
  right: 0;
  bottom: 0;
  border-right-width: 3px;
  border-bottom-width: 3px;
  cursor: nwse-resize;
}

/* edges: invisible strips between the corners */
.handle.n,
.handle.s {
  left: 1.4rem;
  right: 1.4rem;
  height: 1rem;
  cursor: ns-resize;
}

.handle.n {
  top: 0;
}

.handle.s {
  bottom: 0;
}

.handle.e,
.handle.w {
  top: 1.4rem;
  bottom: 1.4rem;
  width: 1rem;
  cursor: ew-resize;
}

.handle.w {
  left: 0;
}

.handle.e {
  right: 0;
}

/* ── Trim bar ── */
.trim {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.play {
  flex: none;
  width: 2.2rem;
  height: 2.2rem;
  border: 1px solid var(--edge);
  border-radius: 50%;
  background: #1f1f1f;
  color: #ddd;
  cursor: pointer;
}

.play svg {
  display: block;
  width: 1.1rem;
  height: 1.1rem;
  margin: auto;
  fill: currentColor;
}

.play:disabled {
  opacity: 0.4;
  cursor: default;
}

.track {
  position: relative;
  flex: 1;
  height: 2.4rem;
  /* room for the grips when the kept part reaches the ends */
  margin: 0 0.9rem;
  border-radius: 0.4rem;
  background: rgba(255, 255, 255, 0.08);
  cursor: pointer;
  touch-action: none;
}

.kept {
  position: absolute;
  top: 0;
  bottom: 0;
  border-top: 3px solid #f5c518;
  border-bottom: 3px solid #f5c518;
  background: rgba(245, 197, 24, 0.12);
}

.grip {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 0.9rem;
  background: #f5c518;
  cursor: ew-resize;
  touch-action: none;
}

.grip.start {
  left: -0.9rem;
  border-radius: 0.4rem 0 0 0.4rem;
}

.grip.end {
  right: -0.9rem;
  border-radius: 0 0.4rem 0.4rem 0;
}

.playhead {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  margin-left: -1px;
  background: #fff;
  pointer-events: none;
}

.times {
  display: flex;
  justify-content: space-between;
  color: #aaa;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

/* ── "Trim: TikTok | Instagram": laid out like the checkbox row below, with a
   two-way switch in the inputs' style (dark fill, the edge; the primary
   button's blue for the one picked) ── */
.promo {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.promo-options {
  flex: none;
  display: flex;
  padding: 2px;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.35);
}

.promo-option {
  padding: 0.35rem 0.7rem;
  border: none;
  border-radius: calc(0.6rem - 2px);
  background: none;
  color: #bbb;
  font-size: 0.8rem;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}

.promo-option:hover:not(:disabled):not(.active) {
  color: #fff;
}

.promo-option.active {
  background: #2d6cdf;
  color: #fff;
}

.promo-option:focus-visible {
  outline: 2px solid #8a5cf6;
  outline-offset: 1px;
}

.promo-option:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── "Compress it too": a checkbox in the inputs' style (dark fill, the edge,
   the primary button's blue once ticked) ── */
.check {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.check.off {
  opacity: 0.4;
  cursor: default;
}

/* the real checkbox stays for the keyboard and screen readers, unseen */
.check input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.box {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  box-sizing: border-box;
  border: 1px solid var(--edge);
  border-radius: 0.35rem;
  background: rgba(0, 0, 0, 0.35);
  transition:
    background 0.12s,
    border-color 0.12s;
}

.box svg {
  width: 0.9rem;
  height: 0.9rem;
  fill: #fff;
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.12s,
    transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1.3);
}

.check:not(.off):hover .box {
  border-color: #2d6cdf;
}

.check input:checked + .box {
  border-color: #2d6cdf;
  background: #2d6cdf;
}

.check input:checked + .box svg {
  opacity: 1;
  transform: none;
}

.check input:focus-visible + .box {
  outline: 2px solid #8a5cf6;
  outline-offset: 2px;
}

.check-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  color: #ddd;
  font-size: 0.85rem;
  line-height: 1.25rem;
}

.check-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}

/* the media's size: the same muted tone as the sizes elsewhere */
.check-size {
  color: #888;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.check-text small {
  color: #8f88aa;
  font-size: 0.72rem;
  line-height: 1.3;
}

@media (prefers-reduced-motion: reduce) {
  .box svg {
    transition: none;
  }
}

/* ── Messages ── */
.hint {
  margin: 0;
  color: #8f88aa;
  font-size: 0.75rem;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
}

/* ── Buttons ── */
.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spacer {
  flex: 1;
}

.button {
  padding: 0.55rem 1.1rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
}

.button:disabled {
  opacity: 0.4;
  cursor: default;
}

.button.primary {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.button.primary:hover:not(:disabled) {
  background: #3b7bf0;
}
</style>
