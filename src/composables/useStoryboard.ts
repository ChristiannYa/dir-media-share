import { onUnmounted, ref, watch, type Ref } from 'vue'
import { fetchStoryboard } from '@/api'
import type { Storyboard } from '@/types'

function preloadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('storyboard image failed to load'))
    img.src = url
  })
}

/**
 * Loads a video's storyboard (a grid image of small frames) and gives the CSS
 * that shows the tile for any time. `board` stays null until the image itself
 * has loaded, so callers can fall back to something else until then.
 */
export function useStoryboard(src: Ref<string | undefined>) {
  const board = ref<Storyboard | null>(null)
  let controller: AbortController | null = null

  async function load(url: string | undefined) {
    controller?.abort()
    board.value = null
    if (!url) return

    const current = new AbortController()
    controller = current
    try {
      const data = await fetchStoryboard(url, current.signal)
      if (!data) return
      await preloadImage(data.url)
      if (!current.signal.aborted) board.value = data
    } catch {
      // aborted or failed: the caller keeps its fallback
    }
  }

  watch(src, (url) => load(url), { immediate: true })
  onUnmounted(() => controller?.abort())

  /** Inline style showing the tile for `time`, scaled to `width` px; null if not loaded */
  function tileStyle(time: number, width: number): Record<string, string> | null {
    const b = board.value
    if (!b) return null
    const scale = width / b.tile_width
    const height = b.tile_height * scale
    const index = Math.min(Math.max(Math.floor(time / b.interval), 0), b.count - 1)
    const column = index % b.columns
    const row = Math.floor(index / b.columns)
    return {
      width: `${width}px`,
      height: `${height}px`,
      backgroundImage: `url("${b.url}")`,
      backgroundSize: `${b.columns * width}px ${b.rows * height}px`,
      backgroundPosition: `${-column * width}px ${-row * height}px`,
    }
  }

  return { board, tileStyle }
}
