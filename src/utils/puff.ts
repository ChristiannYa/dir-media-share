/**
 * A deleted photo / video goes up in a puff of smoke where its card was: the
 * card swells a touch, then shrinks and blurs away while soft clouds burst
 * out of its middle and drift off, fading. Every card of the file plays it
 * (the grid's, and its copies in "Most played" / "Hearted").
 *
 * The clouds live in a layer of their own over the page, so they keep going
 * after the card itself is gone (the folder's listing loads again meanwhile).
 * Reduced motion: the card just fades out.
 */

/** How long the card takes to go (ms): the caller can reload the listing after it */
const CARD_MS = 420
/** How long a cloud drifts and fades (ms, give or take a fifth) */
const CLOUD_MS = 750
/** Clouds per card */
const CLOUDS = 12
/**
 * A card that's still there this long after (the listing didn't reload, or
 * it wasn't removed after all) shows again (ms)
 */
const RESTORE_AFTER_MS = 4000

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The clouds over one card's place */
function smoke(rect: DOMRect) {
  const layer = document.createElement('div')
  layer.setAttribute('aria-hidden', 'true')
  // under the top bar (z-index 10) and the selection bar, over the grid
  layer.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:9;overflow:visible`
  document.body.append(layer)

  const size = Math.min(rect.width, rect.height)
  const cx = rect.width / 2
  const cy = rect.height / 2
  let longest = 0
  for (let i = 0; i < CLOUDS; i++) {
    const cloud = document.createElement('span')
    const d = size * (0.3 + Math.random() * 0.25)
    // out from the middle, all the way around, a little uneven
    const angle = (i / CLOUDS) * Math.PI * 2 + (Math.random() - 0.5) * 0.6
    const dist = size * (0.28 + Math.random() * 0.3)
    // they start spread over the card's middle, not from a single point
    const sx = cx + (Math.random() - 0.5) * rect.width * 0.45
    const sy = cy + (Math.random() - 0.5) * rect.height * 0.45
    cloud.style.cssText = `position:absolute;left:${sx - d / 2}px;top:${sy - d / 2}px;width:${d}px;height:${d}px;border-radius:50%;background:radial-gradient(circle at 40% 35%,rgba(255,255,255,0.95),rgba(228,222,248,0.75) 42%,rgba(196,186,232,0) 70%);filter:blur(${Math.max(1, d * 0.05)}px)`
    layer.append(cloud)

    const dx = Math.cos(angle) * dist
    // smoke rises: a little upward drift on top
    const dy = Math.sin(angle) * dist - size * 0.12
    const duration = CLOUD_MS * (0.8 + Math.random() * 0.4)
    const delay = Math.random() * 90
    longest = Math.max(longest, duration + delay)
    cloud.animate(
      [
        { transform: 'translate(0, 0) scale(0.2)', opacity: 0 },
        {
          transform: `translate(${dx * 0.35}px, ${dy * 0.35}px) scale(1)`,
          opacity: 0.95,
          offset: 0.22,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(1.55)`, opacity: 0 },
      ],
      { duration, delay, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'both' },
    )
  }
  setTimeout(() => layer.remove(), longest + 100)
}

/**
 * Plays the puff on every card of `paths` (deleted files). Resolves once the
 * cards are gone from sight, so the listing can load again without them
 * jumping away first; the clouds go on a moment longer.
 */
export async function puffAway(paths: Iterable<string>): Promise<void> {
  const wanted = new Set(paths)
  const cards = [...document.querySelectorAll<HTMLElement>('.card[data-path]')].filter((el) =>
    wanted.has(el.dataset.path ?? ''),
  )
  if (cards.length === 0) return
  const reduced = reducedMotion()

  const animations = cards.map((card) => {
    const rect = card.getBoundingClientRect()
    const onScreen =
      rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0
    if (onScreen && !reduced) smoke(rect)
    return card.animate(
      reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: 'scale(1)', opacity: 1, filter: 'blur(0px)' },
            { transform: 'scale(1.06)', opacity: 1, filter: 'blur(0px)', offset: 0.2 },
            { transform: 'scale(0.3)', opacity: 0, filter: 'blur(8px)' },
          ],
      {
        duration: reduced ? 180 : CARD_MS,
        easing: 'cubic-bezier(0.4, 0, 0.6, 1)',
        // stays gone until the listing removes it
        fill: 'forwards',
      },
    )
  })

  await Promise.all(animations.map((a) => a.finished.catch(() => {})))
  setTimeout(() => {
    animations.forEach((a, i) => {
      if (cards[i]?.isConnected) a.cancel()
    })
  }, RESTORE_AFTER_MS)
}
