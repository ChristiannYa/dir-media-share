// Picks a playback speed close to the one asked for that plays evenly on
// this screen.
//
// A clip of `fps` frames per second played at speed `s` delivers fps × s
// frames per second. The screen shows a new image only at its refreshes
// (`hz` per second). Motion looks even only if the two line up:
// - each video frame stays up for the same number of refreshes:
//   fps × s = hz / k   (e.g. 30 fps × 1.0 on 60 Hz: every frame shown twice)
// - or the screen shows every m-th video frame:
//   fps × s = hz × m   (e.g. 60 fps × 2.0 on 60 Hz: every 2nd frame)
// Anything in between (30 fps × 1.3 = 39 per second on 60 Hz) shows some
// frames for one refresh and others for two, which reads as stutter.

/** Highest k / m tried: further out the steps get too coarse to matter */
const MAX_DIVISOR = 6
/** Range browsers play reliably */
const MIN_RATE = 0.25
const MAX_RATE = 4

/** Every even-motion speed for this clip on this screen */
function evenSpeeds(fps: number, hz: number): number[] {
  const speeds: number[] = []
  for (let n = 1; n <= MAX_DIVISOR; n++) {
    speeds.push(hz / (n * fps)) // each frame held n refreshes
    speeds.push((hz * n) / fps) // every n-th frame shown
  }
  return speeds.filter((s) => s >= MIN_RATE && s <= MAX_RATE)
}

/**
 * The even-motion speed nearest to `wanted`, if one is within `maxChange`
 * (in ×); otherwise `wanted` itself. With the frame rate or refresh rate
 * unknown, `wanted` as well.
 */
export function smoothSpeed(
  wanted: number,
  fps: number | null,
  hz: number | null,
  maxChange: number,
): number {
  if (!fps || !hz) return wanted
  let best = wanted
  let bestChange = Infinity
  for (const speed of evenSpeeds(fps, hz)) {
    const change = Math.abs(speed - wanted)
    if (change <= maxChange && change < bestChange) {
      best = speed
      bestChange = change
    }
  }
  return best
}
