import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

/**
 * Whether a popup is on screen (ModalDialog.vue: Settings, the file / folder
 * menus, every dialog, the move picker). While one is, the top bar and the
 * alphabet bar slide up off the screen, and they slide back down once the
 * last one closes (BreadcrumbBar.vue).
 */

/** How many popups are open (one can open over another) */
const open = ref(0)

/** True while at least one popup is on screen */
export const popupOpen = computed(() => open.value > 0)

/** How long a popup takes to fade out once closed (ModalDialog.vue's .modal-leave-active, a little more) */
const POPUP_FADE_MS = 200

/**
 * Resolves once no popup is open and the last one has faded away (at once if
 * none was open): for something that should be seen on the page behind it
 */
export function popupsGone(): Promise<void> {
  if (!popupOpen.value) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(popupOpen, (open) => {
      if (open) return
      stop()
      setTimeout(resolve, POPUP_FADE_MS)
    })
  })
}

/** Counts the calling component as an open popup for as long as it's on screen */
export function useMarkPopupOpenWhileMounted() {
  let counted = false
  onMounted(() => {
    open.value++
    counted = true
  })
  onUnmounted(() => {
    if (counted) open.value--
  })
}
