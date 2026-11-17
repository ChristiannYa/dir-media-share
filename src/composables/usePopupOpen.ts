import { computed, onMounted, onUnmounted, ref } from 'vue'

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
