<script setup lang="ts">
import { computed, onUnmounted, ref, toRef, watch } from 'vue'
import { settings } from '@/settings'
import { useScrubPreview } from '@/composables/useScrubPreview'
import { useStoryboard } from '@/composables/useStoryboard'
import { formatDuration } from '@/utils/format'

/**
 * Seek slider with a frame preview above the finger / cursor.
 * The preview comes from the storyboard grid (instant); until that has
 * loaded, frames are grabbed from a hidden copy of the video (slower).
 */
const props = defineProps<{
  src: string
  storyboard?: string
  currentTime: number
  duration: number
  /** Downloaded parts of the video (seconds), drawn as a lighter bar */
  buffered: Array<{ start: number; end: number }>
  /**
   * How many times each equal part of the video was watched (useHeatmap),
   * drawn as a curve over the bar like YouTube's "most replayed"
   */
  heatmap?: number[] | null
  /**
   * The <video> itself: while it plays, the bar follows it every frame
   * instead of jumping at each `currentTime` update (~4 a second)
   */
  media?: HTMLVideoElement | null
}>()
const emit = defineEmits<{ seek: [time: number]; scrubStart: []; scrubEnd: [] }>()

const track = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const { board, tileStyle } = useStoryboard(toRef(props, 'storyboard'))
const { ready, request } = useScrubPreview(toRef(props, 'src'), canvas)

const dragging = ref(false)
/** Time under the finger / cursor, null when not previewing */
const hoverTime = ref<number | null>(null)

function timeAt(e: PointerEvent): number {
  const el = track.value
  if (!el || !props.duration) return 0
  const rect = el.getBoundingClientRect()
  const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
  return fraction * props.duration
}

function previewAt(e: PointerEvent) {
  const time = timeAt(e)
  hoverTime.value = time
  // the slow fallback is only needed until the storyboard is in
  if (!board.value) request(time)
}

function onDown(e: PointerEvent) {
  dragging.value = true
  track.value?.setPointerCapture(e.pointerId)
  previewAt(e)
  emit('scrubStart')
}

function onMove(e: PointerEvent) {
  // a mouse previews just by hovering; touch only while dragging
  if (dragging.value || e.pointerType === 'mouse') previewAt(e)
}

function onUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  emit('seek', timeAt(e))
  emit('scrubEnd')
  if (e.pointerType !== 'mouse') hoverTime.value = null
}

function onCancel() {
  if (dragging.value) emit('scrubEnd')
  dragging.value = false
  hoverTime.value = null
}

function onLeave() {
  if (!dragging.value) hoverTime.value = null
}

function fraction(time: number): number {
  return props.duration ? time / props.duration : 0
}

// ── Smooth progress ──
// The browser reports the position only ~4× a second, so a bar drawn from
// `currentTime` moves in little jumps. While the video plays, its position is
// read every animation frame instead (only this component redraws).

/** The video's position this frame while it plays; null when paused (then `currentTime` is used) */
const liveTime = ref<number | null>(null)
let frame = 0

function tick() {
  const el = props.media
  if (!el || el.paused || el.ended) {
    stopFrames()
    return
  }
  if (el.currentTime !== liveTime.value) liveTime.value = el.currentTime
  frame = requestAnimationFrame(tick)
}

function startFrames() {
  if (!frame) frame = requestAnimationFrame(tick)
}

function stopFrames() {
  cancelAnimationFrame(frame)
  frame = 0
  liveTime.value = null
}

watch(
  () => props.media,
  (el, _old, onCleanup) => {
    stopFrames()
    if (!el) return
    el.addEventListener('playing', startFrames)
    el.addEventListener('pause', stopFrames)
    el.addEventListener('ended', stopFrames)
    if (!el.paused && !el.ended) startFrames()
    onCleanup(() => {
      el.removeEventListener('playing', startFrames)
      el.removeEventListener('pause', stopFrames)
      el.removeEventListener('ended', stopFrames)
      stopFrames()
    })
  },
  { immediate: true },
)

onUnmounted(stopFrames)

/** While dragging, the bar follows the finger instead of the video */
const played = computed(() =>
  fraction(
    dragging.value && hoverTime.value !== null
      ? hoverTime.value
      : (liveTime.value ?? props.currentTime),
  ),
)
const hovered = computed(() => fraction(hoverTime.value ?? 0))

/** Downloaded parts as positions on the bar (0–1) */
const bufferedBars = computed(() =>
  props.buffered.map(({ start, end }) => ({
    left: fraction(start),
    width: Math.max(0, fraction(end) - fraction(start)),
  })),
)

// ── Most watched parts ──

/** Height of the curve's lowest point, in % of its box, so the band is visible all along */
const HEAT_FLOOR = 8
/** Peaks closer than this many parts to the hovered spot get the "Most replayed" label */
const PEAK_REACH = 2

/**
 * The counts smoothed a little (neighbors weigh in) and scaled 0–1 between
 * the least and most watched part; null when there's nothing to show (never
 * watched, or every part the same)
 */
const heatLevels = computed<number[] | null>(() => {
  const counts = props.heatmap
  if (!counts || counts.length === 0) return null
  const at = (i: number) => counts[Math.min(counts.length - 1, Math.max(0, i))] ?? 0
  const smooth = counts.map((_, i) => 0.25 * at(i - 1) + 0.5 * at(i) + 0.25 * at(i + 1))
  const min = Math.min(...smooth)
  const max = Math.max(...smooth)
  if (max - min < 1e-9) return null
  return smooth.map((v) => (v - min) / (max - min))
})

/**
 * The curve as an SVG path in a 1000 × 100 box (stretched to the bar): a point
 * at the middle of each part, joined by curves through the midpoints between
 * them, closed along the bottom
 */
const heatPath = computed(() => {
  const levels = heatLevels.value
  if (!levels) return ''
  const n = levels.length
  const pts = levels.map((v, i) => ({
    x: ((i + 0.5) / n) * 1000,
    y: 100 - (HEAT_FLOOR + v * (100 - HEAT_FLOOR)),
  }))
  const first = pts[0]!
  const last = pts[n - 1]!
  let d = `M0,100 L0,${first.y.toFixed(1)} L${first.x.toFixed(1)},${first.y.toFixed(1)}`
  for (let i = 1; i < n; i++) {
    const p = pts[i - 1]!
    const q = pts[i]!
    const mx = (p.x + q.x) / 2
    const my = (p.y + q.y) / 2
    d += ` Q${p.x.toFixed(1)},${p.y.toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`
  }
  d += ` L${last.x.toFixed(1)},${last.y.toFixed(1)} L1000,${last.y.toFixed(1)} L1000,100 Z`
  return d
})

/** The most watched part (index), if any part was rewatched at all */
const peakBin = computed<number | null>(() => {
  const levels = heatLevels.value
  const counts = props.heatmap
  if (!levels || !counts || Math.max(...counts) < 2) return null
  return levels.indexOf(1)
})

/** The finger / cursor is over the most watched part */
const overPeak = computed(() => {
  const peak = peakBin.value
  const n = props.heatmap?.length ?? 0
  if (peak === null || hoverTime.value === null || !props.duration || !n) return false
  const bin = Math.floor(fraction(hoverTime.value) * n)
  return Math.abs(bin - peak) <= PEAK_REACH
})

const spriteStyle = computed(() =>
  hoverTime.value === null ? null : tileStyle(hoverTime.value, settings.scrubPreviewWidth),
)
</script>

<template>
  <div
    ref="track"
    class="scrubber"
    :class="{ dragging, 'has-heat': heatPath }"
    :style="{
      '--played': played,
      '--hovered': hovered,
      '--preview-width': `${settings.scrubPreviewWidth}px`,
    }"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onCancel"
    @pointerleave="onLeave"
  >
    <!-- most watched parts: a curve over the bar, higher where watched more;
         shown while hovering / dragging, brighter over the played part -->
    <div v-if="heatPath" class="heat" aria-hidden="true">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        <path :d="heatPath" />
      </svg>
      <svg class="heat-played" viewBox="0 0 1000 100" preserveAspectRatio="none">
        <path :d="heatPath" />
      </svg>
    </div>

    <!-- see-through track, lighter where downloaded, rainbow where played -->
    <div class="rail">
      <div
        v-for="(bar, i) in bufferedBars"
        :key="i"
        class="buffered"
        :style="{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }"
      />
      <div class="played" />
    </div>
    <div class="knob" :class="{ active: dragging }" />

    <div v-show="hoverTime !== null" class="bubble theme-glass">
      <div v-if="spriteStyle" class="frame sprite" :style="spriteStyle" />
      <canvas v-else v-show="ready" ref="canvas" class="frame" />
      <span v-if="overPeak" class="peak">Most replayed</span>
      <span class="time">{{ formatDuration(hoverTime ?? 0) || '0:00' }}</span>
    </div>
  </div>
</template>

<style scoped>
.scrubber {
  position: relative;
  height: 24px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none; /* dragging must not scroll the page */
}

/* see-through track: the video shows faintly through the part not played */
.rail {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.16);
  transition: height 0.1s;
}

/* downloaded, like YouTube's light gray bar */
.buffered {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.38);
  transition: width 0.2s linear;
}

/* the whole rainbow spans the track; only the played part is shown, so each
   color stays at the same place on the bar as it fills */
.played {
  position: absolute;
  inset: 0;
  clip-path: inset(0 calc((1 - var(--played)) * 100%) 0 0);
  background: linear-gradient(
    90deg,
    #ff0040,
    #ff8c00,
    #ffe600,
    #00ff6a,
    #00d5ff,
    #5a3cff,
    #d400ff
  );
}

.scrubber:hover .rail,
.scrubber:active .rail {
  height: 6px;
}

/* ── Most watched parts ──
   Sits on the bar, rising above it; faded out until the bar is hovered or
   dragged (a phone only shows it while dragging), like YouTube's */
.heat {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(50% + 3px);
  height: 28px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}

.scrubber.dragging .heat {
  opacity: 1;
}

@media (hover: hover) {
  .scrubber:hover .heat {
    opacity: 1;
  }
}

.heat svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.heat path {
  fill: rgba(255, 255, 255, 0.22);
}

/* the played part of the curve, brighter: the same curve cut off where the bar is */
.heat-played {
  clip-path: inset(0 calc((1 - var(--played)) * 100%) 0 0);
}

.heat-played path {
  fill: rgba(255, 255, 255, 0.42);
}

/* the preview rises above the curve instead of covering it */
.scrubber.has-heat .bubble {
  margin-bottom: 26px;
}

.knob {
  position: absolute;
  left: calc(var(--played) * 100%);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 6px rgba(0, 0, 0, 0.6);
  transform: translateX(-50%);
  pointer-events: none;
  transition: transform 0.1s;
}

.knob.active {
  transform: translateX(-50%) scale(1.3);
}

/* frame preview, kept inside the slider's ends */
.bubble {
  --half: calc(var(--preview-width) / 2 + 3px);
  position: absolute;
  bottom: 100%;
  margin-bottom: 10px;
  left: clamp(var(--half), calc(var(--hovered) * 100%), calc(100% - var(--half)));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 3px;
  /* colored glass: .theme-glass (tokens.css), like the player's buttons */
  border-radius: 8px;
  pointer-events: none;
}

.frame {
  display: block;
  width: var(--preview-width);
  border-radius: 6px;
}

.sprite {
  background-repeat: no-repeat;
}

/* over the most watched part, like YouTube's "Most replayed" */
.peak {
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0 0.3rem;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.time {
  color: #fff;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  padding: 0 0.3rem 2px;
  /* readable over the light parts of the colors */
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
</style>
