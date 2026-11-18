import { onUnmounted, ref, watch, type Ref } from 'vue'

/**
 * Where a photo / video sits inside the box it's fitted in (object-fit:
 * contain, as in fullscreen: the box is the whole screen and the picture is
 * scaled to fit it, with empty bands on the two sides it doesn't fill).
 * Returns how far the picture is from the box's left / right edges (`x`) and
 * top / bottom edges (`y`), in px, so what's drawn over it can be kept inside
 * the picture instead of in the bands. Both 0 when the picture fills the box,
 * or `aspect` (width / height of the picture as shown) is unknown / null.
 * Follows the box's size, and `aspect` when it changes.
 */
export function useContainedInset(
  container: Ref<HTMLElement | null>,
  aspect: () => number | null | undefined,
) {
  const x = ref(0)
  const y = ref(0)

  function update() {
    const el = container.value
    const a = aspect()
    const w = el?.clientWidth ?? 0
    const h = el?.clientHeight ?? 0
    if (!el || !a || a <= 0 || !w || !h) {
      x.value = 0
      y.value = 0
    } else if (w / h > a) {
      // wider than the picture: bands left and right
      x.value = (w - h * a) / 2
      y.value = 0
    } else {
      // taller: bands above and below
      x.value = 0
      y.value = (h - w / a) / 2
    }
  }

  const resize = new ResizeObserver(update)
  watch(
    container,
    (el, old) => {
      if (old) resize.unobserve(old)
      if (el) resize.observe(el)
      update()
    },
    { flush: 'post', immediate: true },
  )
  watch(aspect, update, { flush: 'post' })
  onUnmounted(() => resize.disconnect())

  return { x, y }
}
