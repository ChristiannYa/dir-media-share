<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { backgroundPaused } from '@/composables/useBackgroundPause'
import {
  SKY_MAX_FPS,
  SKY_MILKY_WAY_SHARE,
  SKY_SATELLITE_EVERY,
  SKY_STAR_COLORS,
} from '@/constants'
import { settings } from '@/settings'

/**
 * The whole background behind the gallery, drawn on one opaque canvas: the
 * sky (darkest at the top), two layers of dim nebula clouds drifting their
 * own ways, twinkling stars (some gathered in a faint Milky Way band) sliding
 * sideways at depths, a shooting star every few seconds, and now and then a
 * satellite gliding across.
 *
 * Why one canvas, at most SKY_MAX_FPS: anything that moves behind the page
 * makes the browser recompose it, and re-blur every frosted panel, on every
 * frame. As CSS animations the nebula ran at the screen's full refresh rate
 * (165–240 Hz on gaming laptops) on two layers bigger than the screen; here
 * the clouds are painted once into small images that are only slid around,
 * 30 times a second. Brightness is applied while drawing, not as a CSS filter
 * (which would process the whole screen again each frame).
 *
 * Still while a dialog or the player covers it, and drawn once and left alone
 * with Settings → This device → Display → Animated background off.
 */

/**
 * `ignorePause`: keeps moving while dialogs / the viewer pause the
 * background: for a sky that's itself on top (fullscreen photo / video),
 * with nothing of the gallery drawn behind it
 */
const props = defineProps<{ ignorePause?: boolean }>()

const canvas = ref<HTMLCanvasElement | null>(null)

// ── Stars ──

interface Star {
  /** Position, 0–1 of the screen */
  x: number
  y: number
  /** Core radius (px) */
  r: number
  /** Brightness at rest, 0–1 */
  alpha: number
  /** How much it twinkles, 0–1, and how fast (radians per second) */
  twinkle: number
  speed: number
  phase: number
  /** 0.2 (far, slow) to 1 (near, fast): scales the sideways drift */
  depth: number
  sprite: HTMLCanvasElement
}

interface Streak {
  x: number
  y: number
  /** px per second */
  vx: number
  vy: number
  /** Tail length (px) */
  length: number
  age: number
  /** Seconds it lasts */
  life: number
}

interface Satellite {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Roughly bell-shaped, between -1 and 1: most values near 0 */
function bell(): number {
  return (Math.random() + Math.random() + Math.random()) / 1.5 - 1
}

/** A soft dot (bright center fading out) in `color`, drawn once and reused for every star */
function makeSprite(color: string): HTMLCanvasElement {
  const size = 64
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = size
  const ctx = sprite.getContext('2d')
  if (!ctx) return sprite
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.12, color)
  g.addColorStop(0.3, `${color}40`) // faint halo
  g.addColorStop(1, `${color}00`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return sprite
}

const sprites = SKY_STAR_COLORS.map((c) => ({ sprite: makeSprite(c.color), weight: c.weight }))
const totalWeight = sprites.reduce((sum, s) => sum + s.weight, 0)
const whiteSprite = makeSprite('#ffffff')

function pickSprite(): HTMLCanvasElement {
  let roll = Math.random() * totalWeight
  for (const s of sprites) {
    roll -= s.weight
    if (roll <= 0) return s.sprite
  }
  return whiteSprite
}

/** Height (0–1) of the Milky Way at `x`; repeats every screen width, so it wraps around seamlessly */
function bandY(x: number): number {
  return 0.42 + 0.14 * Math.sin(2 * Math.PI * x) + 0.05 * Math.sin(4 * Math.PI * x + 1)
}

function makeStars(count: number): Star[] {
  return Array.from({ length: count }, () => {
    const inBand = Math.random() < SKY_MILKY_WAY_SHARE
    const x = Math.random()
    const y = inBand ? bandY(x) + bell() * 0.09 : Math.random()
    // mostly tiny stars, a few bright ones
    const size = Math.random() ** 3
    return {
      x,
      y,
      r: (inBand ? 0.35 : 0.45) + size * (inBand ? 0.7 : 1.5),
      alpha: rand(0.35, 0.75) + size * 0.25,
      twinkle: Math.random() < 0.15 ? rand(0.5, 0.8) : rand(0.1, 0.3),
      speed: rand(0.6, 2.4),
      phase: rand(0, Math.PI * 2),
      depth: 0.2 + size * 0.8,
      sprite: pickSprite(),
    }
  })
}

let stars = makeStars(settings.starCount)

let streaks: Streak[] = []
let satellites: Satellite[] = []

// ── Nebula ──
// Each layer is 1.8× the screen (so its edges stay hidden however far it
// drifts), painted once into a small image (quarter resolution: the clouds
// are soft, so it doesn't show) and slid / scaled each frame. Cloud positions
// and sizes are in % of the layer: layer % = (screen % + 40) / 1.8.

/** The layer's size compared to the screen */
const LAYER = 1.8
/** Resolution of the painted clouds compared to the screen */
const NEBULA_SCALE = 0.25

interface Cloud {
  /** Center and radii, 0–1 of the layer */
  x: number
  y: number
  rx: number
  ry: number
  color: string
}

/** One step of a layer's path: offset (0–1 of the layer) and scale */
interface Waypoint {
  at: number
  x: number
  y: number
  s: number
}

interface NebulaLayer {
  clouds: Cloud[]
  /** Sky gradient under the clouds (bottom layer only) */
  sky: boolean
  opacity: number
  path: Waypoint[]
  /** 0–1: where along its path it starts, so the layers are never in step */
  offset: number
  image: HTMLCanvasElement | null
}

const nebula: NebulaLayer[] = [
  {
    // top-left, middle-right, bottom-left, over the sky itself
    clouds: [
      { x: 0.22, y: 0.22, rx: 0.33, ry: 0.28, color: '#2a1450' },
      { x: 0.78, y: 0.53, rx: 0.28, ry: 0.28, color: '#301040' },
      { x: 0.36, y: 0.78, rx: 0.33, ry: 0.25, color: '#0c2c3c' },
    ],
    sky: true,
    opacity: 1,
    path: [
      { at: 0, x: 0, y: 0, s: 1 },
      { at: 0.33, x: 0.12, y: 0.06, s: 1.08 },
      { at: 0.66, x: 0.04, y: -0.1, s: 0.94 },
      { at: 1, x: -0.11, y: 0.08, s: 1.04 },
    ],
    offset: 0,
    image: null,
  },
  {
    // top-right, middle-left, bottom-right; fainter, over the stars, like
    // thin clouds of gas in front of them
    clouds: [
      { x: 0.78, y: 0.22, rx: 0.31, ry: 0.25, color: '#10184a' },
      { x: 0.22, y: 0.56, rx: 0.31, ry: 0.28, color: '#0a2a38' },
      { x: 0.69, y: 0.78, rx: 0.31, ry: 0.25, color: '#2a0f30' },
    ],
    sky: false,
    opacity: 0.7,
    path: [
      { at: 0, x: 0, y: 0, s: 1 },
      { at: 0.33, x: -0.12, y: -0.07, s: 0.94 },
      { at: 0.66, x: -0.03, y: 0.11, s: 1.1 },
      { at: 1, x: 0.1, y: -0.04, s: 0.96 },
    ],
    offset: 0.5,
    image: null,
  },
]

/** The sky's middle color (--page-bg in styles/tokens.css) */
function pageBg(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim() || '#080a1a'
}

/** Paints a layer's clouds (and the sky, for the bottom one) into its small image */
function paintLayer(layer: NebulaLayer) {
  const w = Math.max(1, Math.round(width * LAYER * NEBULA_SCALE))
  const h = Math.max(1, Math.round(height * LAYER * NEBULA_SCALE))
  const image = layer.image ?? document.createElement('canvas')
  image.width = w
  image.height = h
  const c = image.getContext('2d')
  if (!c) return
  c.clearRect(0, 0, w, h)
  if (layer.sky) {
    // darkest at the top; the screen's top and bottom are at 22% / 78% of the layer
    const g = c.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0.22, '#02030a')
    g.addColorStop(0.55, pageBg())
    g.addColorStop(0.78, '#141030')
    c.fillStyle = g
    c.fillRect(0, 0, w, h)
  }
  for (const cloud of layer.clouds) {
    c.save()
    c.translate(cloud.x * w, cloud.y * h)
    c.scale(cloud.rx * w, cloud.ry * h)
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0, cloud.color)
    g.addColorStop(0.7, `${cloud.color}00`)
    c.fillStyle = g
    c.fillRect(-1, -1, 2, 2)
    c.restore()
  }
  layer.image = image
}

/** Smooth start and stop between two waypoints, like CSS ease-in-out */
function ease(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Where a layer is at `time`: back and forth along its path, one way per drift time */
function layerPlace(layer: NebulaLayer): { x: number; y: number; s: number } {
  const duration = settings.bgDriftSeconds
  const first = layer.path[0]!
  if (duration <= 0) return first
  const p = time / duration + layer.offset * 2
  const lap = Math.floor(p)
  // there and back again
  const along = lap % 2 === 0 ? p - lap : 1 - (p - lap)
  for (let i = 1; i < layer.path.length; i++) {
    const a = layer.path[i - 1]!
    const b = layer.path[i]!
    if (along <= b.at) {
      const t = ease((along - a.at) / (b.at - a.at))
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: a.s + (b.s - a.s) * t }
    }
  }
  return layer.path[layer.path.length - 1]!
}

function drawLayer(layer: NebulaLayer) {
  if (!ctx || !layer.image) return
  const place = layerPlace(layer)
  const w = width * LAYER * place.s
  const h = height * LAYER * place.s
  // centered on the screen, moved by part of its own size
  const cx = width / 2 + place.x * width * LAYER
  const cy = height / 2 + place.y * height * LAYER
  ctx.globalAlpha = layer.opacity
  ctx.drawImage(layer.image, cx - w / 2, cy - h / 2, w, h)
}

// ── Canvas ──

let width = 0
let height = 0
let ctx: CanvasRenderingContext2D | null = null

function resize() {
  const el = canvas.value
  if (!el) return
  // sharp on high-density screens, capped so phones don't draw 9× the pixels
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = window.innerWidth
  height = window.innerHeight
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  // opaque: the browser doesn't have to blend it with anything behind
  ctx = el.getContext('2d', { alpha: false })
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  for (const layer of nebula) paintLayer(layer)
  // resizing clears the canvas: when not running, draw once
  if (!raf) render(0)
}

/** Seconds since the sky started */
let time = 0
let nextStreakAt = 2
let nextSatelliteAt = rand(5, SKY_SATELLITE_EVERY)

/** When the next one comes: `every` seconds on average, give or take */
function nextAfter(every: number): number {
  return time + every * rand(0.4, 1.6)
}

function spawnStreak() {
  // from the upper part of the sky, slanting down to the left or right
  const dir = Math.random() < 0.5 ? 1 : -1
  const angle = (rand(15, 40) * Math.PI) / 180
  const speed = rand(700, 1300)
  streaks.push({
    x: rand(0.1, 0.9) * width,
    y: rand(0, 0.45) * height,
    vx: Math.cos(angle) * speed * dir,
    vy: Math.sin(angle) * speed,
    length: rand(90, 230),
    age: 0,
    life: rand(0.5, 1.1),
  })
}

function spawnSatellite() {
  // crosses the whole screen, slowly, on a shallow slant
  const fromLeft = Math.random() < 0.5
  const life = rand(25, 40)
  const startY = rand(0.05, 0.6) * height
  const endY = startY + rand(-0.25, 0.25) * height
  satellites.push({
    x: fromLeft ? -10 : width + 10,
    y: startY,
    vx: ((width + 20) / life) * (fromLeft ? 1 : -1),
    vy: (endY - startY) / life,
    age: 0,
    life,
  })
}

function drawStars() {
  if (!ctx) return
  const drift = time * settings.starDrift
  for (const s of stars) {
    // slides left, wrapping around the edge
    let x = (s.x * width - drift * s.depth) % width
    if (x < 0) x += width
    const y = s.y * height
    const glow = 1 - s.twinkle * (0.5 + 0.5 * Math.sin(time * s.speed + s.phase))
    const d = s.r * 7 // the sprite's halo reaches well past the core
    ctx.globalAlpha = s.alpha * glow
    ctx.drawImage(s.sprite, x - d / 2, y - d / 2, d, d)
  }
}

function drawStreaks(dt: number) {
  if (!ctx) return
  for (const m of streaks) {
    m.age += dt
    m.x += m.vx * dt
    m.y += m.vy * dt
    const progress = m.age / m.life
    // fades in, then out
    const fade = Math.sin(Math.min(progress, 1) * Math.PI)
    // the tail grows in the first moments
    const speed = Math.hypot(m.vx, m.vy)
    const tail = m.length * Math.min(1, m.age * 5)
    const tx = m.x - (m.vx / speed) * tail
    const ty = m.y - (m.vy / speed) * tail
    const g = ctx.createLinearGradient(tx, ty, m.x, m.y)
    g.addColorStop(0, 'rgba(255, 255, 255, 0)')
    g.addColorStop(0.7, `rgba(200, 220, 255, ${0.35 * fade})`)
    g.addColorStop(1, `rgba(255, 255, 255, ${0.9 * fade})`)
    ctx.globalAlpha = 1
    ctx.strokeStyle = g
    ctx.lineWidth = 1.6
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(m.x, m.y)
    ctx.stroke()
    // bright head
    ctx.globalAlpha = fade
    ctx.drawImage(whiteSprite, m.x - 6, m.y - 6, 12, 12)
  }
  streaks = streaks.filter((m) => m.age < m.life)
}

function drawSatellites(dt: number) {
  if (!ctx) return
  for (const s of satellites) {
    s.age += dt
    s.x += s.vx * dt
    s.y += s.vy * dt
    // steady dim light that fades in and out at the ends, with a faint glint now and then
    const edge = Math.min(1, s.age / 3, (s.life - s.age) / 3)
    const glint = Math.sin(s.age * 1.3) > 0.97 ? 1 : 0.55
    ctx.globalAlpha = Math.max(0, edge) * glint
    ctx.drawImage(whiteSprite, s.x - 3.5, s.y - 3.5, 7, 7)
  }
  satellites = satellites.filter((s) => s.age < s.life)
}

/**
 * "Brightness" setting: below 1, a black veil (exactly brightness × b);
 * above 1, the picture added onto itself (b - 1) times over
 */
function applyBrightness() {
  const el = canvas.value
  if (!ctx || !el) return
  const b = settings.bgBrightness
  if (b === 1) return
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (b < 1) {
    ctx.globalAlpha = 1 - b
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, el.width, el.height)
  } else {
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, b - 1)
    ctx.drawImage(el, 0, 0)
  }
  ctx.restore()
}

/** Draws one picture of the sky, `dt` seconds after the last one */
function render(dt: number) {
  if (!ctx) return
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  const [back, front] = nebula
  if (back) drawLayer(back)
  drawStars()
  drawSatellites(dt)
  drawStreaks(dt)
  if (front) drawLayer(front)
  applyBrightness()
}

// ── Loop ──

let raf = 0
let last = 0
const FRAME_MS = 1000 / SKY_MAX_FPS

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  // at most SKY_MAX_FPS: skip screen refreshes until a frame's time has passed
  // (a little slack, so 60 Hz screens don't drop to 20)
  if (last && now - last < FRAME_MS - 2) return
  // big gaps (tab was hidden) shouldn't make everything jump
  const dt = last ? Math.min((now - last) / 1000, 0.1) : 0
  last = now
  time += dt

  if (settings.shootingStarEvery > 0 && time >= nextStreakAt) {
    spawnStreak()
    nextStreakAt = nextAfter(settings.shootingStarEvery)
  }
  if (SKY_SATELLITE_EVERY > 0 && time >= nextSatelliteAt) {
    spawnSatellite()
    nextSatelliteAt = nextAfter(SKY_SATELLITE_EVERY)
  }
  render(dt)
}

function startLoop() {
  if (raf) return
  last = 0 // the paused time doesn't count
  raf = requestAnimationFrame(frame)
}

function stopLoop() {
  cancelAnimationFrame(raf)
  raf = 0
}

/** Runs while animated and nothing covers it; otherwise the last picture stays */
function updateLoop() {
  if (settings.bgAnimated && (props.ignorePause || !backgroundPaused.value)) startLoop()
  else stopLoop()
}

watch([backgroundPaused, () => settings.bgAnimated], updateLoop)

watch(
  () => settings.starCount,
  (count) => {
    stars = makeStars(count)
    if (!raf) render(0)
  },
)

// while still, other look changes still show
watch([() => settings.bgBrightness, () => settings.bgDriftSeconds], () => {
  if (!raf) render(0)
})

// a shooting star setting turned back on shouldn't wait out the old interval
watch(
  () => settings.shootingStarEvery,
  (every) => (nextStreakAt = every > 0 ? nextAfter(every) : Infinity),
)

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  updateLoop()
})

onUnmounted(() => {
  stopLoop()
  window.removeEventListener('resize', resize)
})
</script>

<template>
  <canvas ref="canvas" class="night-sky" aria-hidden="true" />
</template>

<style scoped>
/* fixed behind the page content */
.night-sky {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  pointer-events: none;
}
</style>
