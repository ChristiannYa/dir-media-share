// App mode, switched from the top bar:
// - goon: the normal way. Watching records video data (plays, "last viewed",
//   the most watched parts), and it all shows: view counts, the "Most
//   played" sections, the heatmap over the slider, the menus' dates
// - dev: for working on the app. Nothing is recorded and none of it shows.
//   What was recorded before stays saved on the server, for goon mode
// Each browser keeps its own (localStorage), so one device in dev mode doesn't
// stop the others from counting. The server is told by a cookie
// (APP_MODE_COOKIE), sent with every request: it refuses to record anything
// for a device in dev mode and leaves the data out of its answers
// (server/appMode.ts), so this holds even for a request the app sends anyway.

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

/** True when video data (plays, last viewed, heatmap) is recorded and shown */
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
