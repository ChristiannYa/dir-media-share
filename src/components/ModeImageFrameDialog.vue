<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import FramedImage from '@/components/FramedImage.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import type { ImageFrame } from '@/api'

/**
 * Picks the round part of an app mode image the pill shows (from the popup a
 * tap on the image opens): a circle over the image, moved by dragging it and
 * resized from the corners of its square, with what's outside dimmed. Beside
 * it, the result as big and at the pill's own size. Use hands the frame to
 * the parent (AppModeImageDialog.vue), which saves it and closes this.
 */
const props = defineProps<{
  title: string
  src: string
  /** The frame to start from; null = the biggest centered square */
  frame: ImageFrame | null
  /** The parent is saving it: the buttons wait */
  saving?: boolean
  /** Why saving failed */
  error?: string | null
}>()
const emit = defineEmits<{ use: [frame: ImageFrame]; close: [] }>()

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se']

/** The image's size (its own pixels; the shown size for an SVG without one) */
const size = reactive({ w: 0, h: 0 })
/** The frame, in the image's pixels: top left corner and side */
const box = reactive({ x: 0, y: 0, side: 0 })

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Smallest side: a few pixels, or 5% of the image's short side */
const minSide = computed(() => Math.max(8, 0.05 * Math.min(size.w, size.h)))

function centered() {
  const side = Math.min(size.w, size.h)
  Object.assign(box, { x: (size.w - side) / 2, y: (size.h - side) / 2, side })
}

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  size.w = img.naturalWidth || img.clientWidth
  size.h = img.naturalHeight || img.clientHeight
  const f = props.frame
  if (f) {
    const side = Math.min(f.w * size.w, f.h * size.h, size.w, size.h)
    box.side = side
    box.x = clamp(f.x * size.w, 0, size.w - side)
    box.y = clamp(f.y * size.h, 0, size.h - side)
  } else {
    centered()
  }
}

/** The frame as fractions of the image, as saved */
const frame = computed<ImageFrame | null>(() =>
  size.w
    ? { x: box.x / size.w, y: box.y / size.h, w: box.side / size.w, h: box.side / size.h }
    : null,
)

const pct = (v: number) => `${v * 100}%`

// ── Dragging ──

const stage = ref<HTMLElement | null>(null)
let drag: {
  handle: Handle
  px: number
  py: number
  from: { x: number; y: number; side: number }
  /** image pixels per screen pixel */
  scale: number
} | null = null

function start(e: PointerEvent, handle: Handle) {
  if (!stage.value || !size.w || props.saving) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = {
    handle,
    px: e.clientX,
    py: e.clientY,
    from: { ...box },
    scale: size.w / stage.value.getBoundingClientRect().width,
  }
}

/** The corners' moves bubble up to the frame, so this one listener sees them all */
function move(e: PointerEvent) {
  if (!drag) return
  const { handle, from, scale } = drag
  const dx = (e.clientX - drag.px) * scale
  const dy = (e.clientY - drag.py) * scale
  if (handle === 'move') {
    box.x = clamp(from.x + dx, 0, size.w - from.side)
    box.y = clamp(from.y + dy, 0, size.h - from.side)
    return
  }
  // the opposite corner stays put; the side follows the pointer along the
  // diagonal, as far as the image goes
  const right = from.x + from.side
  const bottom = from.y + from.side
  const west = handle.includes('w')
  const north = handle.includes('n')
  const grow = ((west ? -dx : dx) + (north ? -dy : dy)) / 2
  const room = Math.min(west ? right : size.w - from.x, north ? bottom : size.h - from.y)
  const side = clamp(from.side + grow, Math.min(minSide.value, room), room)
  box.side = side
  box.x = west ? right - side : from.x
  box.y = north ? bottom - side : from.y
}

function end() {
  drag = null
}

// ── Closing ──

function use() {
  if (frame.value) emit('use', frame.value)
}

// Escape closes only this one, not the popup under it (ModalDialog), and not
// while saving (`locked`)
</script>

<template>
  <ModalDialog
    :title="title"
    subtitle="Drag the circle to choose what shows"
    wide
    :locked="saving"
    @close="emit('close')"
  >
    <div class="stage-wrap">
      <div ref="stage" class="stage">
        <img class="picture" :src="src" alt="" draggable="false" @load="onImageLoad" />
        <div
          v-if="size.w"
          class="frame"
          :style="{
            left: pct(box.x / size.w),
            top: pct(box.y / size.h),
            width: pct(box.side / size.w),
            height: pct(box.side / size.h),
          }"
          @pointerdown="start($event, 'move')"
          @pointermove="move"
          @pointerup="end"
          @pointercancel="end"
        >
          <span
            v-for="c in CORNERS"
            :key="c"
            class="corner"
            :class="c"
            @pointerdown.stop="start($event, c)"
          />
        </div>
      </div>
    </div>

    <div class="previews">
      <FramedImage v-if="frame" class="preview big" :src="src" :frame="frame" />
      <div v-if="frame" class="badge-preview">
        <FramedImage class="preview small" :src="src" :frame="frame" />
        <span class="preview-label">Beside the badge</span>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button type="button" class="button ghost" :disabled="!size.w || saving" @click="centered">
        Center
      </button>
      <span class="spacer" />
      <button type="button" class="button" :disabled="saving" @click="emit('close')">
        Cancel
      </button>
      <button type="button" class="button primary" :disabled="!frame || saving" @click="use">
        {{ saving ? 'Saving…' : 'Use' }}
      </button>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* ── Picture and frame (like EditDialog's crop) ── */
.stage-wrap {
  display: flex;
  justify-content: center;
}

.stage {
  position: relative;
  /* keeps the dimming inside the picture */
  overflow: hidden;
  line-height: 0;
  -webkit-user-select: none;
  user-select: none;
}

.picture {
  display: block;
  max-width: 100%;
  max-height: 50dvh;
  /* an SVG without a size of its own still gets one */
  min-width: 8rem;
}

/* the square the circle sits in: holds the corners that resize it */
.frame {
  position: absolute;
  cursor: move;
  touch-action: none;
}

/* the circle: what shows beside the badge. Everything outside it is dimmed
   (the shadow follows the round edge) */
.frame::before {
  content: '';
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border: 2px solid rgba(255, 255, 255, 0.9);
  border-radius: 50%;
  box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

/* corners of the square around the circle: white L shapes, a bit faint */
.corner {
  position: absolute;
  width: 1.4rem;
  height: 1.4rem;
  border: 0 solid rgba(255, 255, 255, 0.7);
  touch-action: none;
}

.corner.nw {
  left: 0;
  top: 0;
  border-left-width: 3px;
  border-top-width: 3px;
  cursor: nwse-resize;
}

.corner.ne {
  right: 0;
  top: 0;
  border-right-width: 3px;
  border-top-width: 3px;
  cursor: nesw-resize;
}

.corner.sw {
  left: 0;
  bottom: 0;
  border-left-width: 3px;
  border-bottom-width: 3px;
  cursor: nesw-resize;
}

.corner.se {
  right: 0;
  bottom: 0;
  border-right-width: 3px;
  border-bottom-width: 3px;
  cursor: nwse-resize;
}

/* ── What it will look like ── */
.previews {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
}

/* round, like beside the badge */
.preview {
  border-radius: 50%;
}

.preview.big {
  width: 6rem;
  height: 6rem;
  border: 1px solid var(--edge-soft);
}

/* the size AppModeButton.vue shows it at */
.preview.small {
  width: 1.6rem;
  height: 1.6rem;
}

.badge-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
}

.preview-label {
  color: #8f88aa;
  font-size: 0.72rem;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
}

/* ── Buttons (as in SettingsDialog) ── */
.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spacer {
  flex: 1;
}

.button {
  padding: 0.55rem 1rem;
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

.button.ghost {
  border-color: transparent;
  background: none;
  box-shadow: none;
  color: #999;
  font-size: 0.8rem;
}

.button.ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}

.button.primary {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.button.primary:hover:not(:disabled) {
  background: #3b7bf0;
}

.button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
