<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { entryFileUrl, queueEdit, renameEntry } from '@/api'
import { pulseCompress } from '@/composables/useCompressQueue'
import { PROMO_OUTROS, REPLACE_CONFIRM, type PromoOutro } from '@/constants'
import type { Entry } from '@/types'
import { formatSize } from '@/utils/format'

/**
 * Edits a video or photo:
 * - its name: changed on the file itself (its views and time watched are in
 *   the metadata dialog, MetadataDialog.vue)
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
/** `changed`: the name was saved, so the listing should be reloaded */
const emit = defineEmits<{ close: []; changed: [] }>()

const isVideo = props.entry.kind === 'video'
const src = entryFileUrl(props.entry)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const pct = (f: number) => `${f * 100}%`

const saving = ref(false)

// ── Name (changed on the file itself) ──

/** Where the file is and what it's called now (they change once a rename is saved) */
let savedPath = props.entry.path
const savedName = ref(props.entry.name)

const newName = ref(props.entry.name)

/** Caught here so it shows while typing; the server checks again */
const nameProblem = computed(() => {
  const n = newName.value.trim()
  if (!n) return 'Enter a name'
  if (/[/\\]/.test(n)) return "A name can't contain / or \\"
  return null
})
const renamed = computed(() => newName.value.trim() !== savedName.value)

// ── Crop: fractions (0–1) of the picture as shown ──

/** Smallest crop, as a fraction of each side */
const MIN_CROP = 0.05
const crop = reactive({ x: 0, y: 0, w: 1, h: 1 })

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']

/**
 * "One side at a time" (a toggle, kept in this browser, on by default): the
 * crop box can't be moved as a whole, and a corner cuts only one of its two
 * sides, the one the pointer starts moving toward (the other stays put). Off:
 * the box moves, and corners cut both sides, like a photo editor's
 */
const oneSide = storedToggle('edit-one-side')
/** How far (px) the pointer goes from a corner before the side it cuts is picked */
const PICK_PX = 4

/** An on / off option kept in this browser (on by default; back to on if it can't be kept) */
function storedToggle(key: string) {
  let on = true
  try {
    on = localStorage.getItem(key) !== 'off'
  } catch {
    // not readable: on
  }
  const toggle = ref(on)
  watch(toggle, (value) => {
    try {
      localStorage.setItem(key, value ? 'on' : 'off')
    } catch {
      // not kept: it's back to on next time
    }
  })
  return toggle
}

// ── Snap to edges ──

/**
 * "Snap to edges" (a toggle, kept in this browser, on by default): a border
 * pulled near an edge in the picture (where it changes sharply all along the
 * border, like a black bar's or a screenshot's frame), or near the picture's
 * own edge, sticks to it. The edges are found once, when a border is grabbed,
 * from the frame shown then, inside the crop as it was
 */
const snapOn = storedToggle('edit-snap')
/** How close (px, as shown) a border has to come to an edge to stick to it */
const SNAP_PX = 4
/** The picture is read at most this many px on its longest side to find the edges */
const SNAP_SAMPLE = 2048
/** Least average change in brightness (0–255) across a line for it to count as an edge */
const EDGE_MIN = 10
/** Edges found when the border was grabbed, as fractions: rows (for the top / bottom), columns (left / right) */
let edges: { rows: number[]; cols: number[] } | null = null
/** The sides ('n', 's', 'e', 'w') stuck to an edge right now: the preview draws them highlighted */
let snappedSides = ''

/**
 * The lines in `p` that stand out: higher than both neighbours and well above
 * the picture's usual change (`p[i]`: the change between line i − 1 and i)
 */
function peaks(p: Float32Array, n: number): number[] {
  if (n < 3) return []
  let sum = 0
  let sq = 0
  for (let i = 1; i < n; i++) {
    sum += p[i]!
    sq += p[i]! * p[i]!
  }
  const mean = sum / (n - 1)
  const sd = Math.sqrt(Math.max(0, sq / (n - 1) - mean * mean))
  const min = Math.max(EDGE_MIN, mean + 3 * sd)
  const found: number[] = []
  for (let i = 1; i < n; i++) {
    const v = p[i]!
    if (v >= min && v >= p[i - 1]! && v > p[i + 1]!) found.push(i / n)
  }
  return found
}

/**
 * Finds the edges in the picture as shown now: for each line between two rows
 * (two columns), how much the brightness changes across it, averaged over the
 * crop's width (height), since that's the length of the border that would
 * stick to it. The picture's own edges are always there. If its pixels can't
 * be read, only those
 */
function findEdges(): { rows: number[]; cols: number[] } {
  const found = { rows: [0, 1], cols: [0, 1] }
  const el = isVideo ? video.value : image.value
  if (!el || !natural.w) return found
  const scale = Math.min(1, SNAP_SAMPLE / Math.max(natural.w, natural.h))
  const w = Math.max(1, Math.round(natural.w * scale))
  const h = Math.max(1, Math.round(natural.h * scale))
  try {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return found
    ctx.drawImage(el, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    const lum = new Float32Array(w * h)
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
      lum[i] = 0.299 * px[j]! + 0.587 * px[j + 1]! + 0.114 * px[j + 2]!
    }
    // only what's inside the crop: what's cut off already doesn't count
    const x0 = clamp(Math.floor(crop.x * w), 0, w)
    const x1 = clamp(Math.ceil((crop.x + crop.w) * w), x0 + 1, w)
    const y0 = clamp(Math.floor(crop.y * h), 0, h)
    const y1 = clamp(Math.ceil((crop.y + crop.h) * h), y0 + 1, h)
    const rows = new Float32Array(h + 1)
    const cols = new Float32Array(w + 1)
    for (let y = 1; y < h; y++) {
      const a = (y - 1) * w
      const b = y * w
      let s = 0
      for (let x = x0; x < x1; x++) s += Math.abs(lum[b + x]! - lum[a + x]!)
      rows[y] = s / (x1 - x0)
    }
    for (let y = y0; y < y1; y++) {
      const b = y * w
      for (let x = 1; x < w; x++) cols[x] = cols[x]! + Math.abs(lum[b + x]! - lum[b + x - 1]!)
    }
    for (let x = 1; x < w; x++) cols[x] = cols[x]! / (y1 - y0)
    found.rows.push(...peaks(rows, h))
    found.cols.push(...peaks(cols, w))
  } catch {
    // its pixels can't be read: only the picture's own edges
  }
  return found
}

/**
 * `v` stuck to the nearest of `list` within SNAP_PX (as shown: `size` px is
 * the whole picture), if that one is between `lo` and `hi`; else `v` itself
 */
function snapTo(v: number, list: number[], size: number, lo: number, hi: number, side: string) {
  let best = v
  let dist = SNAP_PX / size
  for (const edge of list) {
    const d = Math.abs(edge - v)
    if (d <= dist && edge >= lo && edge <= hi) {
      best = edge
      dist = d
    }
  }
  if (best !== v || list.includes(v)) snappedSides += side
  return best
}

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
  // the whole box stays where it is: only its sides are cut
  if (handle === 'move' && oneSide.value) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  cropDrag = {
    handle,
    px: e.clientX,
    py: e.clientY,
    from: { ...crop },
    rect: frame.value.getBoundingClientRect(),
  }
  // moving the whole box has no border to look at
  if (handle !== 'move') {
    const r = cropDrag.rect
    hold.x = clamp((e.clientX - r.left) / r.width, 0, 1)
    hold.y = clamp((e.clientY - r.top) / r.height, 0, 1)
    heldHandle.value = handle
    holding.value = true
    snappedSides = ''
    edges = snapOn.value ? findEdges() : null
    previewLoop()
  }
}

/** The handles' moves bubble up to the crop box, so this one listener sees them all */
function moveCrop(e: PointerEvent) {
  if (!cropDrag) return
  if (oneSide.value && cropDrag.handle.length === 2) {
    // a corner: nothing moves until the pointer has gone a little, then only
    // the side it went toward (more sideways: the left / right one, else the
    // top / bottom one) is cut for the rest of the drag
    const mx = e.clientX - cropDrag.px
    const my = e.clientY - cropDrag.py
    if (Math.hypot(mx, my) < PICK_PX) return
    const side = (Math.abs(mx) > Math.abs(my) ? cropDrag.handle[1] : cropDrag.handle[0]) as Handle
    cropDrag.handle = side
    heldHandle.value = side
  }
  const { handle, from, rect } = cropDrag
  hold.x = clamp((e.clientX - rect.left) / rect.width, 0, 1)
  hold.y = clamp((e.clientY - rect.top) / rect.height, 0, 1)
  // while the zoomed preview shows, the crop follows the pointer more slowly
  const slow = heldHandle.value ? PRECISION : 1
  const dx = ((e.clientX - cropDrag.px) / rect.width) * slow
  const dy = ((e.clientY - cropDrag.py) / rect.height) * slow
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
  snappedSides = ''
  if (snapOn.value && edges) {
    const { width: sw, height: sh } = rect
    if (handle.includes('w')) left = snapTo(left, edges.cols, sw, 0, right - MIN_CROP, 'w')
    if (handle.includes('e')) right = snapTo(right, edges.cols, sw, left + MIN_CROP, 1, 'e')
    if (handle.includes('n')) top = snapTo(top, edges.rows, sh, 0, bottom - MIN_CROP, 'n')
    if (handle.includes('s')) bottom = snapTo(bottom, edges.rows, sh, top + MIN_CROP, 1, 's')
  }
  Object.assign(crop, { x: left, y: top, w: right - left, h: bottom - top })
}

function endCrop() {
  cropDrag = null
  edges = null
  snappedSides = ''
  holding.value = false
  heldHandle.value = null
  cancelAnimationFrame(raf)
}

// ── Zoomed preview while a crop handle is held ──

const image = ref<HTMLImageElement | null>(null)
const preview = ref<HTMLCanvasElement | null>(null)
/** A crop handle is being held: the zoomed preview shows */
const holding = ref(false)
/** The handle held (not the box itself): the preview zooms in on where it is */
const heldHandle = ref<Handle | null>(null)
/** How much closer than the picture as shown */
const ZOOM = 8
/** How far the crop moves per pixel the pointer moves while the preview shows (1 = as far) */
const PRECISION = 0.25
/** Longest a wide / tall strip gets, in px (a crop longer than that at this zoom shows the part around the pointer) */
const MAX_WIDE = 600
const MAX_TALL = 420
/** Where the pointer is on the picture, as fractions of it */
const hold = { x: 0, y: 0 }
/** An edge's preview: this thick, in px, around the border */
const STRIP = 110
/** Extra shown past the crop's ends, as a fraction of its length, so the side borders show too */
const PAD = 0.08
let raf = 0

/**
 * Draws the spot being cropped, zoomed in: an edge shows the border along its
 * whole length (a strip with the border in the middle), a corner the square
 * around it. What's cut off is dimmed and the border is outlined
 */
function drawPreview() {
  const c = preview.value
  const el = isVideo ? video.value : image.value
  const h = heldHandle.value
  if (!c || !el || !h || !cropDrag || !natural.w) return

  const shownW = cropDrag.rect.width
  /** source pixels per pixel as shown */
  const k = natural.w / shownW
  const left = crop.x * natural.w
  const right = (crop.x + crop.w) * natural.w
  const top = crop.y * natural.h
  const bottom = (crop.y + crop.h) * natural.h

  let cw: number
  let ch: number
  let sw: number
  let sh: number
  let sx: number
  let sy: number
  const padX = crop.w * natural.w * PAD
  const padY = crop.h * natural.h * PAD
  if (h === 'e' || h === 'w') {
    // a tall strip: the border across it. All the crop's height (and a bit
    // more) if that fits at this zoom; else the part around the pointer
    const full = (bottom - top + 2 * padY) / k
    ch = Math.min(full * ZOOM, MAX_TALL)
    cw = STRIP
    sh = (ch / ZOOM) * k
    sy = clamp(hold.y * natural.h - sh / 2, top - padY, bottom + padY - sh)
    sw = (cw / ZOOM) * k
    sx = (h === 'w' ? left : right) - sw / 2
  } else {
    // a wide strip (top, bottom and the corners): the border along it. All
    // the crop's width (and a bit more) if that fits at this zoom; else the
    // part around the pointer (a corner: around the corner)
    const full = (right - left + 2 * padX) / k
    cw = Math.min(full * ZOOM, MAX_WIDE, window.innerWidth - 48)
    ch = STRIP
    sw = (cw / ZOOM) * k
    const cx = h.length === 2 ? (h.includes('w') ? left : right) : hold.x * natural.w
    sx = clamp(cx - sw / 2, left - padX, right + padX - sw)
    sh = (ch / ZOOM) * k
    sy = (h.includes('n') ? top : bottom) - sh / 2
  }

  const dpr = window.devicePixelRatio || 1
  c.width = Math.round(cw * dpr)
  c.height = Math.round(ch * dpr)
  c.style.width = `${cw}px`
  c.style.height = `${ch}px`
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.drawImage(el, sx, sy, sw, sh, 0, 0, cw, ch)

  // the crop frame, where it falls in this view (what's outside it is dimmed)
  const zx = cw / sw
  const zy = ch / sh
  const ix = (left - sx) * zx
  const iy = (top - sy) * zy
  const iw = (right - left) * zx
  const ih = (bottom - top) * zy
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.beginPath()
  ctx.rect(0, 0, cw, ch)
  ctx.rect(ix, iy, iw, ih)
  ctx.fill('evenodd')
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(ix, iy, iw, ih)

  // a side stuck to an edge: drawn in the trim bar's yellow
  if (snappedSides) {
    ctx.strokeStyle = '#f5c518'
    ctx.lineWidth = 2
    ctx.beginPath()
    if (snappedSides.includes('n')) {
      ctx.moveTo(ix, iy)
      ctx.lineTo(ix + iw, iy)
    }
    if (snappedSides.includes('s')) {
      ctx.moveTo(ix, iy + ih)
      ctx.lineTo(ix + iw, iy + ih)
    }
    if (snappedSides.includes('w')) {
      ctx.moveTo(ix, iy)
      ctx.lineTo(ix, iy + ih)
    }
    if (snappedSides.includes('e')) {
      ctx.moveTo(ix + iw, iy)
      ctx.lineTo(ix + iw, iy + ih)
    }
    ctx.stroke()
  }
}

/** Redraws every frame while held, so it stays live if the video plays */
function previewLoop() {
  drawPreview()
  if (holding.value) raf = requestAnimationFrame(previewLoop)
}

/** Placed on the other side of the picture from the held spot, out of the way (and of a finger) */
const previewStyle = computed(() => {
  const h = heldHandle.value
  if (!h) return {}
  const style: Record<string, string> = {}
  if (h === 'e' || h === 'w') {
    // tall strip, on the side of the picture away from the held edge
    const x = h === 'w' ? crop.x : crop.x + crop.w
    style[x < 0.5 ? 'right' : 'left'] = '0.5rem'
    style.top = '50%'
    style.transform = 'translateY(-50%)'
  } else {
    // wide strip, centered, in the half of the picture away from the held edge
    const y = h.includes('n') ? crop.y : crop.y + crop.h
    style[y < 0.5 ? 'bottom' : 'top'] = '0.5rem'
    style.left = '50%'
    style.transform = 'translateX(-50%)'
  }
  return style
})

onUnmounted(() => cancelAnimationFrame(raf))

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

/** The start can be moved to where the video is now: past the start, and far enough from the end */
const canStartHere = computed(
  () => current.value > trim.start + 0.05 && current.value <= trim.end - MIN_LENGTH,
)

/**
 * "Start here": the part kept starts where the video is now (the start
 * handle jumps to the playhead), so what's before it is cut off
 */
function trimStartHere() {
  if (saving.value) return
  const v = video.value
  v?.pause()
  const t = v?.currentTime ?? current.value
  trim.start = clamp(t, 0, trim.end - MIN_LENGTH)
  seek(trim.start)
}

/** The end can be moved to where the video is now: before the end, and far enough from the start */
const canEndHere = computed(
  () => current.value < trim.end - 0.05 && current.value >= trim.start + MIN_LENGTH,
)

/**
 * "End here": the part kept ends where the video is now (the end handle
 * jumps to the playhead), so what's after it is cut off
 */
function trimEndHere() {
  if (saving.value) return
  const v = video.value
  v?.pause()
  const t = v?.currentTime ?? current.value
  trim.end = clamp(t, trim.start + MIN_LENGTH, duration.value)
  // the end was moved by hand: no longer an app's outro cut off
  promo.value = null
  seek(trim.end)
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
const promoSummary = PROMO_KEYS.map(
  (k) => `${PROMO_OUTROS[k].label} ${PROMO_OUTROS[k].secs} s`,
).join(', ')

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

const cropped = computed(() => crop.x > 0.001 || crop.y > 0.001 || crop.w < 0.999 || crop.h < 0.999)
const trimmed = computed(() => isVideo && (trim.start > 0.05 || trim.end < duration.value - 0.05))
/** A copy is made (trim / crop) */
const makesCopy = computed(() => cropped.value || trimmed.value)
const hasChanges = computed(() => makesCopy.value || renamed.value)
const canSave = computed(() => hasChanges.value && !nameProblem.value && !saving.value)

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
}

/** The name was saved on the server: the folder is listed again when the dialog closes */
let anythingSaved = false

/**
 * Renames it, then adds the trimmed / cropped copy (named
 * after the new name) to the queue, as far as each changed, and closes. A
 * step that fails stops there: the ones before stay saved, and Save tries the
 * rest again. The copy shows up in the folder once the queue has made it
 * (App reloads the folder), with the "Edited!" banner.
 *
 * `replace` (the "Replace original" button, after asking): no copy; once the
 * queue is done, the result takes this file's place, with its name (a video's
 * extension becomes .mp4), heart and views, and the original goes to the
 * trash. It wears the "Edited!" (and "Compressed!") badges until it's opened
 */
async function save(replace = false) {
  if (!canSave.value || (replace && !makesCopy.value)) return
  if (replace && !confirm(REPLACE_CONFIRM.replace('{name}', newName.value.trim()))) return
  saving.value = true
  error.value = ''
  video.value?.pause()
  try {
    if (renamed.value) {
      savedPath = await renameEntry(savedPath, newName.value.trim())
      savedName.value = newName.value.trim()
      anythingSaved = true
    }
    if (makesCopy.value) {
      // the haptic tap and the top bar's pulse right away, as for Compress
      pulseCompress()
      // a photo has nothing to trim
      const { start, end } = isVideo ? trim : { start: 0, end: 0 }
      await queueEdit(savedPath, { start, end, ...crop }, compressAfter.value, replace)
    }
    close()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Saving failed'
  } finally {
    saving.value = false
  }
}

/** Closes; if the name was saved, the folder is listed again */
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
    <!-- the file itself: its name -->
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
          @keydown.enter.prevent="save()"
        />
      </label>
    </div>
    <p v-if="renamed && nameProblem" class="error">{{ nameProblem }}</p>

    <div class="stage">
      <div class="wrap">
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
          <img
            v-else
            ref="image"
            class="media"
            :src="src"
            alt=""
            draggable="false"
            @load="onImageLoad"
          />

          <div
            class="crop"
            :class="{ fixed: oneSide }"
            :style="{
              left: pct(crop.x),
              top: pct(crop.y),
              width: pct(crop.w),
              height: pct(crop.h),
            }"
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

        <!-- the spot being cropped, zoomed in, while a handle is held -->
        <canvas v-show="holding" ref="preview" class="preview" :style="previewStyle" />
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
        <!-- where the video is now (the white line), then how much is kept -->
        <span>
          <span class="now" title="Where the video is now">{{ formatTime(current) }}</span>
          · {{ formatTime(trim.end - trim.start) }} kept
        </span>
        <span>{{ formatTime(trim.end) }}</span>
      </div>

      <!-- cut off the logo outro an app adds to its downloads: moves the end
           of the part kept (the yellow handle) back by that many seconds -->
      <div class="promo">
        <span class="check-text">
          <span class="check-title">Trim</span>
        </span>
        <!-- the start moves to the playhead: what's before it is cut off -->
        <button
          type="button"
          class="trim-here"
          :disabled="saving || !canStartHere"
          :title="`Start the part kept at ${formatTime(current)} (where the video is now)`"
          @click="trimStartHere"
        >
          <!-- the start grip's bracket, "[" -->
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 4H8v16h6" class="tool-line" />
          </svg>
        </button>
        <!-- the end moves to the playhead: what's after it is cut off -->
        <button
          type="button"
          class="trim-here"
          :disabled="saving || !canEndHere"
          :title="`End the part kept at ${formatTime(current)} (where the video is now)`"
          @click="trimEndHere"
        >
          <!-- the end grip's bracket, "]" -->
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 4h6v16h-6" class="tool-line" />
          </svg>
        </button>
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

    <!-- the crop's tools, laid out like the "Trim" row above: how the white
         frame's handles behave while it's being cut (each on / off by itself) -->
    <div class="promo">
      <span class="check-text">
        <span class="check-title">Crop</span>
      </span>
      <div class="tool-options" role="group" aria-label="Crop tools">
        <!-- the crop box can't be moved as a whole, and corners cut one side only -->
        <button
          type="button"
          class="tool"
          :class="{ active: oneSide }"
          :aria-pressed="oneSide"
          :disabled="saving"
          title="One side at a time: the crop can't be moved as a whole, and a corner cuts only one side"
          @click="oneSide = !oneSide"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="5" width="16" height="14" rx="1.5" class="tool-dash" />
            <path d="M4 19h16" class="tool-bold" />
          </svg>
          One side
        </button>
        <!-- a border pulled near an edge in the picture sticks to it -->
        <button
          type="button"
          class="tool"
          :class="{ active: snapOn }"
          :aria-pressed="snapOn"
          :disabled="saving"
          title="Snap to edges: a border pulled near an edge in the picture (a black bar, a frame) sticks to it"
          @click="snapOn = !snapOn"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4v16" class="tool-bold" />
            <path d="M20 12H10m0 0 4-4m-4 4 4 4" class="tool-line" />
          </svg>
          Snap
        </button>
      </div>
    </div>

    <!-- not an edit: what happens to the copy once the edit has made it.
         Only means something once there's a copy to make (trim / crop) -->
    <p class="after-title">After the edit</p>
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
        <small>Once the edited copy is made; only the compressed one is kept</small>
      </span>
    </label>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button class="button" :disabled="saving || !hasChanges" @click="reset">Reset</button>
      <button class="button" :disabled="saving" @click="close">Cancel</button>
      <!-- no copy: the result takes this file's place once done (asks first) -->
      <button
        class="button replace"
        :disabled="!canSave || !makesCopy"
        title="Put the result in place of this file instead of saving a copy (the original goes to the trash)"
        @click="save(true)"
      >
        Replace original
      </button>
      <button class="button primary" :disabled="!canSave" @click="save()">
        {{ saving ? 'Saving…' : makesCopy && !renamed ? 'Save copy' : 'Save' }}
      </button>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* ── Name ── */
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

/* its position is set by previewStyle; it may be wider than the picture */
.wrap {
  position: relative;
}

/* "One side at a time": the box itself isn't draggable */
.crop.fixed {
  cursor: default;
}

.preview {
  position: absolute;
  z-index: 2;
  border: 2px solid #fff;
  border-radius: 0.5rem;
  background: #000;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
  /* never takes the drag from the crop box */
  pointer-events: none;
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

/* "Start here" / "End here": actions (not a choice), so buttons of their own, in the
   group's dark fill and edge; the trim bar's yellow for its icon */
.trim-here {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.35);
  color: #ddd;
  font-size: 0.8rem;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}

.trim-here svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: #f5c518;
}

.trim-here:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}

.trim-here:focus-visible {
  outline: 2px solid #8a5cf6;
  outline-offset: 1px;
}

.trim-here:disabled {
  opacity: 0.4;
  cursor: default;
}

/* where the video is now, in the times under the bar: white like the playhead */
.now {
  color: #fff;
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

/* ── "Crop: One side | Snap": the edit's tools, in the Trim row's group (dark
   fill, the edge), but each a toggle of its own: on shows a blue tint and
   ring rather than the solid blue of the one picked in Trim (one of several) ── */
.tool-options {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.35);
}

.tool {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.65rem;
  border: 1px solid transparent;
  border-radius: calc(0.6rem - 2px);
  background: none;
  color: #999;
  font-size: 0.8rem;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s,
    color 0.12s;
}

.tool svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
}

.tool-dash {
  stroke-width: 1.5;
  stroke-dasharray: 2 2;
}

.tool-bold {
  stroke-width: 3;
  stroke-linecap: round;
}

.tool-line {
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tool:hover:not(:disabled):not(.active) {
  color: #fff;
}

.tool.active {
  border-color: rgba(45, 108, 223, 0.7);
  background: rgba(45, 108, 223, 0.22);
  color: #fff;
}

.tool:focus-visible {
  outline: 2px solid #8a5cf6;
  outline-offset: 1px;
}

.tool:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── "After the edit": set apart from the edit's tools above by a line, with
   a small heading, as it's not part of the edit but done to its copy after ── */
.after-title {
  margin: 0;
  padding-top: 0.7rem;
  border-top: 1px solid var(--edge);
  color: #8f88aa;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
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
/* Reset, Cancel, Replace original, Save copy: four columns of the same width;
   a label that doesn't fit wraps, and the row's buttons stay the same height */
.actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5rem;
}

.button {
  /* less on the sides than before: the widths are set by the columns */
  padding: 0.55rem 0.5rem;
  text-align: center;
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

/* "Replace original": the original goes to the trash, so the red of the
   other destructive buttons (CompressDialog's "Stop all") */
.button.replace {
  color: #f07060;
  border-color: rgba(231, 76, 60, 0.35);
}

.button.replace:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  color: #ff8a7a;
}
</style>
