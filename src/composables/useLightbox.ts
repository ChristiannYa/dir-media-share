import { onMounted, onUnmounted, ref } from 'vue'
import type { Entry } from '@/types'

/** The entry shown full size, closed with Escape */
export function useLightbox() {
  const selected = ref<Entry | null>(null)

  function show(entry: Entry) {
    selected.value = entry
  }

  function close() {
    selected.value = null
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))

  return { selected, show, close }
}
