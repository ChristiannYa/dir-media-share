// Making a copy of a photo that fits a file size (not a crop: the whole
// picture stays), in the browser:
//
// 1. Re-encode it at full resolution, searching for the best quality that
//    still fits the size
// 2. Only if even a low quality is too big, scale it down (keeping its
//    proportions) just enough to fit at a good quality, and search again
//
// JPEGs stay JPEG; PNG and WebP become WebP, which keeps transparency (JPEG
// if the browser can't write WebP, transparent parts then turn white).
// Rotation from the camera is applied to the pixels. Other metadata (camera,
// GPS, date taken) isn't kept.

/** Lowest quality tried before scaling down instead (0–1) */
const MIN_QUALITY = 0.4
/** Highest quality tried: above it files grow a lot for no visible gain */
const MAX_QUALITY = 0.92
/** Quality aimed for when the picture has to be scaled down */
const SCALED_QUALITY = 0.8
/** Steps of the quality search; each halves the gap (6 → within ~0.01) */
const SEARCH_STEPS = 6
/** Scale-down rounds before giving up */
const MAX_SCALE_ROUNDS = 8
/** Shortest side it may be scaled down to (px) */
const MIN_SIDE = 64

export class ShrinkCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export type ShrinkResult =
  | {
      kind: 'shrunk'
      /** Size of the original, in bytes */
      before: number
      blob: Blob
      /** Extension of the copy, without the dot */
      ext: 'jpg' | 'webp'
      width: number
      height: number
      /** Size of the original picture (rotation applied) */
      originalWidth: number
      originalHeight: number
      /** Quality it was encoded at (0–1) */
      quality: number
    }
  | { kind: 'skipped'; before: number; note: string }

export interface ShrinkHooks {
  /** Aborting it stops the work; it then throws a ShrinkCancelled */
  signal: AbortSignal
  /** What it's doing now, to show ("Encoding 4032×3024…") */
  onStep?: (step: string) => void
}

function checkAborted(signal: AbortSignal) {
  if (signal.aborted) throw new ShrinkCancelled()
}

/** Draws the picture at w×h; `opaque`: on white, for formats without transparency */
function draw(bitmap: ImageBitmap, w: number, h: number, opaque: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The browser could not draw the picture')
  if (opaque) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  return canvas
}

/** Frees a canvas' pixels right away instead of waiting for garbage collection */
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode the picture'))),
      type,
      quality,
    )
  })
}

/**
 * The best quality of `canvas` that fits `target` bytes, or null if even
 * MIN_QUALITY is too big
 */
async function bestQuality(
  canvas: HTMLCanvasElement,
  type: string,
  target: number,
  signal: AbortSignal,
): Promise<{ blob: Blob; quality: number } | null> {
  const top = await encode(canvas, type, MAX_QUALITY)
  checkAborted(signal)
  if (top.size <= target) return { blob: top, quality: MAX_QUALITY }

  const bottom = await encode(canvas, type, MIN_QUALITY)
  checkAborted(signal)
  if (bottom.size > target) return null

  let best = { blob: bottom, quality: MIN_QUALITY }
  let lo = MIN_QUALITY
  let hi = MAX_QUALITY
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const mid = (lo + hi) / 2
    const blob = await encode(canvas, type, mid)
    checkAborted(signal)
    if (blob.size <= target) {
      best = { blob, quality: mid }
      lo = mid
    } else {
      hi = mid
    }
  }
  return best
}

/** True if the browser can write `type` from a canvas (Safari writes PNG instead of WebP) */
async function canEncode(type: string): Promise<boolean> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  try {
    return (await encode(canvas, type, 0.8)).type === type
  } catch {
    return false
  } finally {
    release(canvas)
  }
}

/**
 * Makes a copy of the photo at `url` (named `name`) that's at most `target`
 * bytes. Skipped (not an error) if it's already that small, or the copy
 * wouldn't be any smaller.
 */
export async function shrinkImage(
  url: string,
  name: string,
  target: number,
  { signal, onStep }: ShrinkHooks,
): Promise<ShrinkResult> {
  try {
    onStep?.('Loading…')
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`Loading the photo failed (${res.status})`)
    const original = await res.blob()
    checkAborted(signal)
    const before = original.size
    if (before <= target) {
      return { kind: 'skipped', before, note: 'Already that small, so no copy was made' }
    }

    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(original)
    } catch {
      throw new Error('The browser could not read this photo')
    }
    checkAborted(signal)

    try {
      const isJpeg = /\.jpe?g$/i.test(name)
      const webp = !isJpeg && (await canEncode('image/webp'))
      const type = webp ? 'image/webp' : 'image/jpeg'
      const ext = webp ? 'webp' : 'jpg'
      const W = bitmap.width
      const H = bitmap.height

      let scale = 1
      for (let round = 0; round < MAX_SCALE_ROUNDS; round++) {
        const w = Math.max(1, Math.round(W * scale))
        const h = Math.max(1, Math.round(H * scale))
        if (Math.min(w, h) < MIN_SIDE) break
        onStep?.(scale === 1 ? `Encoding ${w}×${h}…` : `Resizing to ${w}×${h}…`)

        const canvas = draw(bitmap, w, h, !webp)
        try {
          const best = await bestQuality(canvas, type, target, signal)
          if (best) {
            if (best.blob.size >= before) {
              return { kind: 'skipped', before, note: "The copy wouldn't be any smaller, so none was made" }
            }
            return {
              kind: 'shrunk',
              before,
              blob: best.blob,
              ext,
              width: w,
              height: h,
              originalWidth: W,
              originalHeight: H,
              quality: best.quality,
            }
          }
          // too big even at a low quality: the file size goes with the pixel
          // count, so scale the sides by the square root of how far off it is
          // at a good quality (a bit more, so it doesn't land just over)
          const sample = await encode(canvas, type, SCALED_QUALITY)
          checkAborted(signal)
          scale *= Math.min(0.9, Math.sqrt(target / sample.size) * 0.95)
        } finally {
          release(canvas)
        }
      }
      throw new Error("It can't get that small without becoming tiny")
    } finally {
      bitmap.close()
    }
  } catch (e) {
    if (signal.aborted) throw new ShrinkCancelled()
    if (e instanceof TypeError) throw new Error('Connection lost') // fetch's network errors
    throw e
  }
}

/**
 * Name of the copy: the original's with the size it was made to fit, e.g.
 * "beach.png" → "beach [500KB].webp"
 */
export function shrunkName(name: string, targetLabel: string, ext: string): string {
  const dot = name.lastIndexOf('.')
  let base = dot > 0 ? name.slice(0, dot) : name
  // names are at most 255 bytes: leave room for the tag, the extension and a " (2)"
  const encoder = new TextEncoder()
  const room = 255 - encoder.encode(` [${targetLabel}].${ext}`).length - 8
  while (encoder.encode(base).length > room) base = base.slice(0, -1)
  return `${base} [${targetLabel}].${ext}`
}
