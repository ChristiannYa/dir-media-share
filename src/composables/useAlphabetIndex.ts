import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { Entry } from '@/types'

/** A name's index letter: A–Z (accents dropped), anything else is '#' */
export function letterOf(name: string): string {
  const c = name.normalize('NFD').charAt(0).toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}

/**
 * Where the "reading line" is (page y, px), like Neovim's cursor with
 * scrolloff=999: in the middle of the screen while scrolling, but over the
 * first half screen of scrolling it runs from the first row down to the
 * middle, and over the last half screen from the middle down to the bottom
 * of the last row. So the very top reads the first card and the very bottom
 * the last one, whatever is in the middle of the screen there.
 */
function readingLine(scrollY: number, maxScroll: number, gridTop: number, gridBottom: number) {
  const middle = window.innerHeight / 2
  // how much scrolling the top and bottom stretches take (less on short pages)
  const ramp = Math.min(middle, maxScroll / 2)
  if (ramp <= 0) return gridTop
  if (scrollY <= ramp) {
    const end = ramp + middle
    return gridTop + (end - gridTop) * (scrollY / ramp)
  }
  const bottomStart = maxScroll - ramp
  if (scrollY >= bottomStart) {
    const start = bottomStart + middle
    return start + (gridBottom - start) * ((scrollY - bottomStart) / ramp)
  }
  return scrollY + middle
}

/**
 * The first letters in the open folder, and the one being read now. Null
 * while the page doesn't scroll, or while `enabled()` returns false.
 *
 * Which card is "being read": the row the reading line (above) is in, and in
 * that row, left to right as the line moves down through it. With one card
 * per row that's simply the card at the line; with three, the first third of
 * the row's height reads the left card, the next the middle one, the last
 * the right one. So "b c c" reads b, then c; "d e f" reads d, e, f.
 */
export function useAlphabetIndex(entries: Ref<Entry[]>, enabled: () => boolean = () => true) {
  const letters = computed(() =>
    [...new Set(entries.value.map((e) => letterOf(e.name)))].sort((a, b) =>
      a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b),
    ),
  )
  const byPath = computed(() => new Map(entries.value.map((e) => [e.path, e])))
  const current = ref<string | null>(null)

  type Row = { top: number; bottom: number; cards: HTMLElement[] }

  /**
   * The cards in rows, how far the page scrolls, and where the grid starts
   * and ends (page y); null while the page doesn't scroll or has no cards
   */
  function layout(): { rows: Row[]; maxScroll: number; gridTop: number; gridBottom: number } | null {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight
    if (maxScroll <= 1) return null
    const scrollY = window.scrollY

    // the cards by where they start, top to bottom, then left to right. The
    // grid is a masonry (App.vue): columns of cards of different heights, so
    // page order and the order down the screen can differ. Only the folder's
    // grid: the "Most played" section above it isn't in alphabetical order,
    // so it's left out (the index starts where the grid does)
    const cards = [...document.querySelectorAll<HTMLElement>('.card[data-path]')]
      .filter((el) => !el.closest('.most-played'))
      .map((el) => {
        const rect = el.getBoundingClientRect()
        return { el, top: rect.top + scrollY, bottom: rect.bottom + scrollY, left: rect.left }
      })
      .sort((a, b) => a.top - b.top || a.left - b.left)

    // "rows": cards starting at the same height (the first row of the grid,
    // and any that happen to line up), left to right; most others are a
    // row of their own
    const rows: Row[] = []
    for (const { el, top, bottom } of cards) {
      const row = rows.at(-1)
      if (row && Math.abs(row.top - top) < 2) {
        row.cards.push(el)
        row.bottom = Math.max(row.bottom, bottom)
      } else {
        rows.push({ top, bottom, cards: [el] })
      }
    }
    const first = rows[0]
    if (!first) return null

    // the grid's bottom: the lowest card bottom (in a masonry, the card that
    // starts last isn't always the one that ends last)
    const gridBottom = Math.max(...rows.map((r) => r.bottom))
    return { rows, maxScroll, gridTop: first.top, gridBottom }
  }

  let frame = 0
  function measure() {
    frame = 0
    const l = layout()
    if (!l) {
      current.value = null
      return
    }
    const { rows } = l
    const y = readingLine(window.scrollY, l.maxScroll, l.gridTop, l.gridBottom)

    // the row the line is in: each reaches down to the next one's top, so
    // the gap between rows belongs to the row above it
    let i = 0
    while (i + 1 < rows.length && rows[i + 1]!.top <= y) i++
    const row = rows[i]!
    const end = rows[i + 1]?.top ?? row.bottom
    // how far down the row the line is, 0–1: that far along it, left to right
    const along = Math.min(Math.max((y - row.top) / Math.max(end - row.top, 1), 0), 0.9999)
    const card = row.cards[Math.floor(along * row.cards.length)]!
    const entry = byPath.value.get(card.dataset.path!)
    current.value = entry ? letterOf(entry.name) : null
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure)
  }

  // the page's height changes as thumbnails load or columns change
  const resize = new ResizeObserver(schedule)
  watch(entries, () => nextTick(schedule))

  onMounted(() => {
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    resize.observe(document.documentElement)
    schedule()
  })
  onUnmounted(() => {
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    resize.disconnect()
    cancelAnimationFrame(frame)
  })

  /**
   * Scrolls the page to the first card of the grid (top to bottom, left to
   * right) whose name starts with `letter`: exactly to where the reading line
   * reads it, so the alphabet bar then shows that letter as the current one.
   * `smooth`: glides there (a tapped letter); otherwise at once (scrubbing,
   * so the page keeps up with the finger).
   */
  function scrollToLetter(letter: string, smooth = false) {
    const l = layout()
    if (!l) return
    const { rows } = l
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const k = row.cards.findIndex((el) => {
        const entry = byPath.value.get(el.dataset.path!)
        return entry !== undefined && letterOf(entry.name) === letter
      })
      if (k < 0) continue
      // the middle of that card's share of the row (see `measure`)
      const end = rows[i + 1]?.top ?? row.bottom
      const y = row.top + ((k + 0.5) / row.cards.length) * (end - row.top)
      // the reading line only moves down as the page does: find the scroll
      // that puts it at y by halving the range
      let lo = 0
      let hi = l.maxScroll
      for (let step = 0; step < 30 && hi - lo > 0.5; step++) {
        const mid = (lo + hi) / 2
        if (readingLine(mid, l.maxScroll, l.gridTop, l.gridBottom) < y) lo = mid
        else hi = mid
      }
      window.scrollTo({ top: Math.ceil(hi), behavior: smooth ? 'smooth' : 'instant' })
      return
    }
  }

  const alphabet = computed(() =>
    current.value && enabled() ? { letters: letters.value, current: current.value } : null,
  )
  return { alphabet, scrollToLetter }
}
