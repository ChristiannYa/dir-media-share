import { ref } from 'vue'

/**
 * The current time (ms), updated every minute: anything showing "n minutes
 * ago" reads it, so an open menu counts on by itself instead of staying at
 * the time it was opened
 */
export const minuteClock = ref(Date.now())

setInterval(() => (minuteClock.value = Date.now()), 60_000)
