<script setup lang="ts">
import { computed } from 'vue'
import { lockTimeLeft } from '@/composables/useLock'

/**
 * Time left until the app locks by itself (Settings → Server → Lock screen →
 * Lock after): a padlock and m:ss (h:mm:ss from an hour up). Nothing when it
 * never locks. Turns amber in the last minute. Where it sits and its
 * background are up to the parent (top bar, viewer, player).
 */

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
</script>

<template>
  <span
    v-if="text"
    class="lock-timer"
    :class="{ ending }"
    title="Locks when this runs out (Settings → Server → Lock screen)"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6zm3 11a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"
      />
    </svg>
    {{ text }}
  </span>
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
</style>
