import { onUnmounted } from 'vue'

/** How long a finger has to stay down to count as a hold */
const HOLD_MS = 500
/** A finger that moves further than this (px) is scrolling, not holding */
const HOLD_SLOP_PX = 10

/**
 * Right-click (mouse) or press-and-hold (touch) on an element calls
 * `onTrigger`, e.g. to open its menu. Bind `listeners` with v-on on the
 * element, and check `consumeClick()` first thing in its click handler: a
 * hold can be followed by a click when the finger lifts, which must not also
 * open the item. `enabled` is checked on each press (off e.g. in selection mode).
 *
 * Android fires `contextmenu` on a long press by itself; iOS doesn't, so
 * touches also run their own timer; whichever comes first wins. Presses that
 * start on a button (the heart…) are left to that button.
 */
export function useContextHold(onTrigger: () => void, enabled: () => boolean = () => true) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let startX = 0
  let startY = 0
  /** This press already opened the menu: a later contextmenu / click is ignored */
  let fired = false

  function cancel() {
    clearTimeout(timer)
    timer = undefined
  }

  function trigger() {
    cancel()
    fired = true
    onTrigger()
  }

  function onButton(e: Event): boolean {
    return e.target instanceof Element && e.target.closest('button') !== null
  }

  const listeners = {
    contextmenu(e: MouseEvent) {
      if (!enabled() || onButton(e)) return
      e.preventDefault() // no browser menu
      if (!fired) trigger()
    },
    pointerdown(e: PointerEvent) {
      fired = false
      if (e.pointerType === 'mouse' || !enabled() || onButton(e)) return
      startX = e.clientX
      startY = e.clientY
      cancel()
      timer = setTimeout(trigger, HOLD_MS)
    },
    pointermove(e: PointerEvent) {
      if (timer === undefined) return
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > HOLD_SLOP_PX) cancel()
    },
    pointerup: cancel,
    pointercancel: cancel,
    pointerleave: cancel,
  }

  /** True if this click ends a press that opened the menu: ignore it */
  function consumeClick(): boolean {
    if (!fired) return false
    fired = false
    return true
  }

  onUnmounted(cancel)

  return { listeners, consumeClick }
}
