// App mode, switched from the top bar:
// - goon: the normal way. Watching records video data (plays, "last viewed",
//   the most watched parts), as do hearts and opening a compressed copy
// - dev: for working on the app. Everything shows just like in goon mode
//   (view counts, the "Most played" and "Hearted" sections, the heatmap over
//   the slider, the menus' dates), but nothing is recorded
// Each browser keeps its own (localStorage), so one device in dev mode doesn't
// stop the others from counting. The server is told by a cookie
// (APP_MODE_COOKIE), sent with every request: it refuses to record anything
// for a device in dev mode (server/appMode.ts), so this holds even for a
// request the app sends anyway.

import { computed, ref, watch } from 'vue'
import { APP_MODE_COOKIE, APP_MODE_STORAGE_KEY } from '@/constants'

export type AppMode = 'dev' | 'goon'

/** How long the cookie is kept (seconds): a year; it's set again on every start */
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60

function readMode(): AppMode {
  try {
    return localStorage.getItem(APP_MODE_STORAGE_KEY) === 'dev' ? 'dev' : 'goon'
  } catch {
    return 'goon'
  }
}

/** This device's mode. Reactive */
export const appMode = ref<AppMode>(readMode())

/** True when data (plays, last viewed, heatmap, hearts, compressed copies seen) is recorded */
export const recordsVideoData = computed(() => appMode.value === 'goon')

export function toggleAppMode() {
  appMode.value = appMode.value === 'goon' ? 'dev' : 'goon'
}

watch(
  appMode,
  (mode) => {
    // the server goes by the cookie: set before any request of this mode is sent
    document.cookie = `${APP_MODE_COOKIE}=${mode}; Path=/; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`
    try {
      localStorage.setItem(APP_MODE_STORAGE_KEY, mode)
    } catch {
      // storage unavailable (private window): the mode lasts until reload
    }
  },
  { immediate: true, flush: 'sync' },
)
