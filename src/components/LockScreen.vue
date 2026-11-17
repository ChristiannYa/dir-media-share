<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { login } from '@/api'
import { haptic } from '@/utils/haptics'

/**
 * iOS 7 style passcode screen: round number keys with their letters, OK and
 * Delete. The passcode's length is never known here (the server doesn't say),
 * so nothing gives it away: the row above the keys starts empty, and each
 * typed digit adds a geometric figure of its own, which appears as a small
 * circle, grows, and morphs into its shape. The figures are picked at
 * random, not by digit, so someone looking over your shoulder learns nothing
 * from them. OK (or Enter) sends the passcode; a wrong one shakes the
 * figures and clears them. After too many misses the server makes it wait,
 * and the title counts down.
 */

/** `remainingMs`: until the app locks by itself (null = never) */
const emit = defineEmits<{ unlocked: [remainingMs: number | null] }>()

const KEYS = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
]

/** More than any real passcode; keeps the row of figures from growing forever */
const MAX_DIGITS = 32

// ── Figures ──
// Each figure is a white square cut to its shape by a clip-path polygon. A
// polygon can only morph into another with the same number of points, so
// every shape (and the circle it starts as) is described by the same
// RAY_COUNT points: where rays from the center, evenly spread, leave it. The
// circle then morphs by each point sliding straight in or out. 120 rays (one
// every 3°) land exactly on every corner of the shapes below, keeping them sharp.

type Point = [number, number]

const RAY_COUNT = 120

/** Corners of a regular polygon (a star with `inner`) in a 24×24 box, first one up, turned by `turn`° */
function corners(count: number, radius: number, { inner = 0, turn = 0 } = {}): Point[] {
  const total = inner ? count * 2 : count
  return Array.from({ length: total }, (_, i) => {
    const r = inner && i % 2 ? inner : radius
    const angle = ((-90 + turn) * Math.PI) / 180 + (i * 2 * Math.PI) / total
    return [12 + r * Math.cos(angle), 12 + r * Math.sin(angle)]
  })
}

const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0]

/** How far from the center a ray at `angle` leaves the shape */
function reach(shape: Point[], angle: number): number {
  const dir: Point = [Math.cos(angle), Math.sin(angle)]
  let nearest = Infinity
  shape.forEach((p, i) => {
    const q = shape[(i + 1) % shape.length]!
    const edge: Point = [q[0] - p[0], q[1] - p[1]]
    const denom = cross(dir, edge)
    if (Math.abs(denom) < 1e-9) return // parallel
    const toP: Point = [p[0] - 12, p[1] - 12]
    const t = cross(toP, edge) / denom
    const s = cross(toP, dir) / denom
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) nearest = Math.min(nearest, t)
  })
  return nearest
}

/** A clip-path with one point per ray, starting straight up, going clockwise */
function clipPath(radiusAt: (angle: number) => number): string {
  const points = Array.from({ length: RAY_COUNT }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / RAY_COUNT
    const r = radiusAt(angle)
    const x = ((12 + r * Math.cos(angle)) / 24) * 100
    const y = ((12 + r * Math.sin(angle)) / 24) * 100
    return `${x.toFixed(2)}% ${y.toFixed(2)}%`
  })
  return `polygon(${points.join(', ')})`
}

/** What every figure starts as */
const CIRCLE = clipPath(() => 10)

/** The figures a digit can become, as clip-paths */
const SHAPES: Record<string, string> = Object.fromEntries(
  Object.entries({
    triangle: corners(3, 11),
    square: corners(4, 11, { turn: 45 }),
    diamond: corners(4, 11),
    pentagon: corners(5, 10.5),
    hexagon: corners(6, 10.5),
    star: corners(5, 11.5, { inner: 4.8 }),
  }).map(([name, shape]) => [name, clipPath((angle) => reach(shape, angle))]),
)
const SHAPE_NAMES = Object.keys(SHAPES)

/** Appears as a small circle, grows, then morphs into its shape */
function onFigureEnter(el: Element, done: () => void) {
  const shape = SHAPES[(el as HTMLElement).dataset.shape ?? ''] ?? CIRCLE
  el.animate(
    [
      { clipPath: CIRCLE, transform: 'scale(0.3)', opacity: 0 },
      { clipPath: CIRCLE, transform: 'scale(1)', opacity: 1, offset: 0.35 },
      { clipPath: shape, transform: 'scale(1)', opacity: 1 },
    ],
    { duration: 420, easing: 'ease-out' },
  ).onfinish = done
}

/** Deleted (or cleared after a wrong passcode): shrinks back into a circle and fades */
function onFigureLeave(el: Element, done: () => void) {
  const shape = SHAPES[(el as HTMLElement).dataset.shape ?? ''] ?? CIRCLE
  el.animate(
    [
      { clipPath: shape, transform: 'scale(1)', opacity: 1 },
      { clipPath: CIRCLE, transform: 'scale(0.3)', opacity: 0 },
    ],
    { duration: 180, easing: 'ease-in' },
  ).onfinish = done
}

interface Figure {
  id: number
  shape: string
}

const figures = ref<Figure[]>([])
let nextId = 0

/** A random figure, never the same as the one before it */
function pickShape(): string {
  const last = figures.value.at(-1)?.shape
  const choices = SHAPE_NAMES.filter((s) => s !== last)
  return choices[Math.floor(Math.random() * choices.length)]!
}

// ── Typing ──

const entered = ref('')
/** Waiting for the server, or shaking: keys do nothing */
const busy = ref(false)
const shaking = ref(false)

// ── Lockout countdown ──
const lockedUntil = ref(0)
const now = ref(Date.now())
let tick: number | undefined
const waitLeft = computed(() => Math.max(0, lockedUntil.value - now.value))
watch(lockedUntil, () => {
  clearInterval(tick)
  tick = window.setInterval(() => {
    now.value = Date.now()
    if (waitLeft.value === 0) clearInterval(tick)
  }, 1000)
})

const title = computed(() => {
  if (waitLeft.value === 0) return 'Enter Passcode'
  const minutes = Math.ceil(waitLeft.value / 60_000)
  return minutes > 1
    ? `Try again in ${minutes} minutes`
    : `Try again in ${Math.ceil(waitLeft.value / 1000)} s`
})

function press(digit: string) {
  if (busy.value || waitLeft.value > 0 || entered.value.length >= MAX_DIGITS) return
  haptic('tap')
  entered.value += digit
  figures.value.push({ id: nextId++, shape: pickShape() })
}

function remove() {
  if (busy.value) return
  entered.value = entered.value.slice(0, -1)
  figures.value.pop()
}

async function submit() {
  if (busy.value || waitLeft.value > 0 || !entered.value) return
  haptic('tap')
  busy.value = true
  const result = await login(entered.value).catch(() => ({ ok: false as const, retryAfter: 0 }))
  if (result.ok) {
    emit('unlocked', result.remainingMs)
    return
  }
  if (result.retryAfter > 0) {
    now.value = Date.now()
    lockedUntil.value = now.value + result.retryAfter
  }
  shaking.value = true // onShakeEnd clears the figures
}

function onShakeEnd() {
  shaking.value = false
  entered.value = ''
  figures.value = []
  busy.value = false
}

// typing on a keyboard works too
function onKeydown(e: KeyboardEvent) {
  if (/^\d$/.test(e.key)) press(e.key)
  else if (e.key === 'Backspace') remove()
  else if (e.key === 'Enter') void submit()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearInterval(tick)
})
</script>

<template>
  <!-- the empty touchstart makes :active work on iOS Safari -->
  <div class="lock" @touchstart.passive="() => {}">
    <p class="title">{{ title }}</p>

    <div class="figures-row" :class="{ shaking }" @animationend.self="onShakeEnd">
      <TransitionGroup
        tag="div"
        class="figures"
        :css="false"
        @enter="onFigureEnter"
        @leave="onFigureLeave"
      >
        <span
          v-for="f in figures"
          :key="f.id"
          class="figure"
          :data-shape="f.shape"
          :style="{ clipPath: SHAPES[f.shape] }"
          aria-hidden="true"
        />
      </TransitionGroup>
    </div>

    <div class="pad" :class="{ disabled: waitLeft > 0 }">
      <button v-for="k in KEYS" :key="k.digit" class="key" type="button" @click="press(k.digit)">
        <span class="digit">{{ k.digit }}</span>
        <span v-if="k.letters" class="letters">{{ k.letters }}</span>
      </button>
      <button v-if="entered.length" class="text-btn ok" type="button" @click="submit">OK</button>
      <button class="key zero" type="button" @click="press('0')">
        <span class="digit">0</span>
      </button>
      <button v-if="entered.length" class="text-btn delete" type="button" @click="remove">
        Delete
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The app's font (--font-body, tokens.css) is inherited from body */
.lock {
  --key-size: min(78px, 22vw);
  --key-gap: min(28px, 6vw);
  --figure-size: 26px;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  color: #fff;
  /* the sky shows through, blurred, like iOS's frosted wallpaper */
  background: rgba(10, 12, 30, 0.35);
  -webkit-backdrop-filter: blur(4px) saturate(140%);
  backdrop-filter: blur(4px) saturate(140%);
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.title {
  margin: 0;
  font-size: 1.25rem;
  letter-spacing: 0.01em;
}

/* ── Figures ── */
.figures-row {
  margin-bottom: 1rem;
}

/* one line tall while empty, so the keys don't jump when typing begins;
   wraps (centered) if many digits are typed */
.figures {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
  min-height: var(--figure-size);
  max-width: calc(3 * var(--key-size) + 2 * var(--key-gap));
}

/* white, cut to its shape by the clip-path set on it (and animated) in the script */
.figure {
  width: var(--figure-size);
  height: var(--figure-size);
  background: #fff;
}

.figures-row.shaking {
  animation: shake 0.45s ease-in-out;
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  15% {
    transform: translateX(-14px);
  }
  30% {
    transform: translateX(12px);
  }
  45% {
    transform: translateX(-9px);
  }
  60% {
    transform: translateX(6px);
  }
  75% {
    transform: translateX(-3px);
  }
}

/* ── Keys ── */
.pad {
  display: grid;
  grid-template-columns: repeat(3, var(--key-size));
  gap: calc(var(--key-gap) * 0.7) var(--key-gap);
  transition: opacity 0.2s;
}

.pad.disabled {
  opacity: 0.35;
  pointer-events: none;
}

.key {
  width: var(--key-size);
  height: var(--key-size);
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.9);
  background: transparent;
  color: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  touch-action: manipulation; /* no double-tap zoom when typing fast */
  /* fades back out after a press, like iOS */
  transition: background-color 0.35s ease-out;
}

.key:active {
  background: rgba(255, 255, 255, 0.35);
  transition: none;
}

.digit {
  font-size: calc(var(--key-size) * 0.42);
  line-height: 1;
}

.letters {
  font-size: calc(var(--key-size) * 0.12);
  letter-spacing: 0.18em;
  margin-top: 2px;
}

.zero {
  grid-column: 2;
  grid-row: 4;
}

/* OK and Delete sit in the bottom corners, where iOS has Emergency and Cancel */
.text-btn {
  grid-row: 4;
  align-self: center;
  background: none;
  border: none;
  color: #fff;
  font: inherit;
  font-size: 1.05rem;
  cursor: pointer;
  touch-action: manipulation;
}

.ok {
  grid-column: 1;
}

.delete {
  grid-column: 3;
}
</style>
