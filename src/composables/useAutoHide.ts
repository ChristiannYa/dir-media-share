import { onUnmounted, ref, toValue, type MaybeRefOrGetter } from 'vue'

/**
 * A `visible` flag that turns false after `delayMs` without a call to show().
 * While `canHide()` returns false (e.g. while dragging the slider) it waits.
 * `delayMs` may be a getter: it's read each time the countdown starts.
 */
export function useAutoHide(
  delayMs: MaybeRefOrGetter<number>,
  canHide: () => boolean = () => true,
) {
  const visible = ref(true)
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function schedule() {
    clear()
    timer = setTimeout(() => {
      if (canHide()) visible.value = false
      else schedule()
    }, toValue(delayMs))
  }

  function show() {
    visible.value = true
    schedule()
  }

  function hide() {
    clear()
    visible.value = false
  }

  function toggle() {
    if (visible.value) hide()
    else show()
  }

  schedule()
  onUnmounted(clear)

  return { visible, show, hide, toggle }
}
