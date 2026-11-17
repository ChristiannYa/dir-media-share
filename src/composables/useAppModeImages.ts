import { reactive, ref } from 'vue'
import { fetchAppModeImages, type ImageFrame } from '@/api'
import type { AppMode } from '@/appMode'
import { API } from '@/constants'

/**
 * The images beside the app mode pill, shared by every pill (top bar,
 * viewer) and the popup that changes them (AppModeImageDialog.vue), so a new
 * image or frame shows everywhere as soon as it's saved. A mode without one
 * of its own shows its built-in one, if it has one (dev: a code icon).
 */

export const APP_MODES: AppMode[] = ['goon', 'dev']

/** A mode's image: where to load it, and the square part shown (null = the centered one) */
export interface ModeImage {
  src: string
  frame: ImageFrame | null
}

/** Per mode, the image uploaded for it; null while loading or if it has none */
export const appModeImages = reactive<Record<AppMode, ModeImage | null>>({ goon: null, dev: null })

/** The server said which images there are: a mode without one can show its built-in one */
const known = ref(false)

let loaded = false

/** Dev mode's built-in image: a code icon, </>, light on dark (round once shown) */
const CODE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" fill="#16202e"/>
  <path d="M9 8.5 5.5 12 9 15.5M15 8.5l3.5 3.5-3.5 3.5M13.2 6.8l-2.4 10.4"
    fill="none" stroke="#7dd3fc" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

/** What a mode shows when it has no image of its own */
const BUILT_IN: Partial<Record<AppMode, ModeImage>> = {
  dev: { src: `data:image/svg+xml,${encodeURIComponent(CODE_ICON_SVG)}`, frame: null },
}

/**
 * What `mode` shows: its own image, or else its built-in one (only once the
 * server said it has none, so the built-in one doesn't flash in first)
 */
export function shownModeImage(mode: AppMode): ModeImage | null {
  return appModeImages[mode] ?? (known.value ? (BUILT_IN[mode] ?? null) : null)
}

/** Asks the server again (after Settings saved a new image or frame) */
export async function refreshAppModeImages(): Promise<void> {
  const info = await fetchAppModeImages()
  for (const mode of APP_MODES) {
    const image = info[mode]
    appModeImages[mode] = image
      ? {
          // the version changes with each new image: the browser loads it again
          src: `${API.appModeImage}?mode=${mode}&v=${image.version}`,
          frame: image.frame,
        }
      : null
  }
  known.value = true
}

/** The images, loaded from the server the first time they're needed */
export function useAppModeImages() {
  if (!loaded) {
    loaded = true
    refreshAppModeImages().catch(() => {
      loaded = false // try again next time
    })
  }
  return appModeImages
}
