<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { lockNow, lockTimeLeft } from '@/composables/useLock'
import { haptic } from '@/utils/haptics'

/**
 * Time left until the app locks by itself (Settings → Server → Lock screen →
 * Lock after): a padlock and m:ss (h:mm:ss from an hour up). Nothing when it
 * never locks. Turns amber in the last minute. Where it sits and its
 * background are up to the parent (top bar, viewer, player).
 *
 * `lockable` (the top bar): it's a button, and two taps lock the app now. The
 * first tap swells it a little, until the second tap or until too late for one.
 */

const props = defineProps<{ lockable?: boolean }>()

const text = computed(() => {
  const ms = lockTimeLeft.value
  if (ms === null) return null
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
})

const ending = computed(() => lockTimeLeft.value !== null && lockTimeLeft.value <= 60_000)

// ── Double tap to lock ──

/** How long after the first tap the second one still locks */
const DOUBLE_TAP_MS = 400

/** Tapped once: swollen, waiting for the second tap */
const armed = ref(false)
let disarm: number | undefined
let locking = false

async function onTap() {
  if (!props.lockable || locking) return
  haptic('tap')
  if (!armed.value) {
    armed.value = true
    disarm = window.setTimeout(() => (armed.value = false), DOUBLE_TAP_MS)
    return
  }
  clearTimeout(disarm)
  armed.value = false
  locking = true
  try {
    await lockNow()
  } catch {
    // the server couldn't be reached: stays unlocked
  } finally {
    locking = false
  }
}

onUnmounted(() => clearTimeout(disarm))
</script>

<template>
  <component
    :is="lockable ? 'button' : 'span'"
    v-if="text"
    :type="lockable ? 'button' : undefined"
    class="lock-timer"
    :class="{ ending, lockable, armed }"
    :title="
      lockable
        ? 'Double-tap to lock now'
        : 'Locks when this runs out (Settings → Server → Lock screen)'
    "
    @click="onTap"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6zm3 11a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"
      />
    </svg>
    {{ text }}
  </component>
</template>

<style scoped>
.lock-timer {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transition: color 0.3s;
}

.lock-timer svg {
  width: 0.95em;
  height: 0.95em;
  fill: currentColor;
}

/* the last minute */
.lock-timer.ending {
  color: #f5a623;
}

/* a button that looks like the plain badge: its size, padding, glass and
   border come from the parent's classes (.bar-timer, .theme-glass), like the
   app mode pill beside it (also a button, so both have the same line height) */
.lock-timer.lockable {
  margin: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation; /* no double-tap zoom, no click delay */
  transition:
    color 0.3s,
    transform 0.15s ease-out;
}

/* tapped once: waiting for the second tap */
.lock-timer.armed {
  transform: scale(1.12);
}
</style>
