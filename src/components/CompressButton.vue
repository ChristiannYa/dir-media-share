<script setup lang="ts">
import { computed, ref } from 'vue'
import CompressDialog from '@/components/CompressDialog.vue'
import { compressPercent, useCompressQueue } from '@/composables/useCompressQueue'
import { ICON_COMPRESS } from '@/icons'

/**
 * The top bar's compress button, between the app mode's image and Settings:
 * there whenever the server's compress queue lists anything (useCompressQueue),
 * on every device and in every folder, until the ended ones are cleared. A
 * ring around it fills as the queue goes, with how many are left on it; green
 * with a check once all have ended. A tap opens the progress popup
 * (CompressDialog.vue).
 */

const { list, activeCount } = useCompressQueue()
const open = ref(false)

/** The ring's circumference (r = 10 in a 24×24 box) */
const RING = 2 * Math.PI * 10

const percent = computed(() => (activeCount.value > 0 ? compressPercent(list.value) : 100))
const running = computed(() => activeCount.value > 0)

const label = computed(() =>
  running.value
    ? `Compressing: ${activeCount.value} left, ${Math.floor(percent.value)}%`
    : 'Compressions finished',
)
</script>

<template>
  <Transition name="compress-btn">
    <button
      v-if="list.length > 0"
      type="button"
      class="compress-btn"
      :class="{ running }"
      :aria-label="label"
      :title="label"
      @click="open = true"
    >
      <svg viewBox="0 0 24 24" class="ring" aria-hidden="true">
        <circle class="track" cx="12" cy="12" r="10" />
        <circle
          class="progress"
          cx="12"
          cy="12"
          r="10"
          :stroke-dasharray="RING"
          :stroke-dashoffset="RING * (1 - percent / 100)"
        />
      </svg>
      <svg v-if="running" viewBox="0 0 24 24" class="icon" aria-hidden="true">
        <path :d="ICON_COMPRESS" />
      </svg>
      <svg v-else viewBox="0 0 24 24" class="icon check" aria-hidden="true">
        <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
      </svg>
      <span v-if="running" class="count">{{ activeCount }}</span>
    </button>
  </Transition>
  <CompressDialog v-if="open" @close="open = false" />
</template>

<style scoped>
.compress-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  border: none;
  background: none;
  color: var(--bar-btn-color);
  cursor: pointer;
  transition: color 0.15s;
  -webkit-tap-highlight-color: transparent;
}

.compress-btn:hover {
  color: #f0ecff;
}

.compress-btn > svg {
  grid-area: 1 / 1;
}

.ring {
  width: 100%;
  height: 100%;
  /* the ring starts at the top */
  transform: rotate(-90deg);
}

.ring circle {
  fill: none;
  stroke-width: 2.2;
}

.track {
  stroke: rgba(255, 255, 255, 0.12);
}

.progress {
  stroke: #8a5cf6;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.4s linear;
}

.compress-btn:not(.running) .progress {
  stroke: #3fae62;
}

.icon {
  width: 0.8rem;
  height: 0.8rem;
  fill: currentColor;
}

.icon.check {
  color: #6fdc8c;
}

/* while it runs: the ring breathes */
.compress-btn.running .ring {
  animation: breathe 2s ease-in-out infinite;
}

@keyframes breathe {
  50% {
    filter: drop-shadow(0 0 3px rgba(138, 92, 246, 0.8));
  }
}

/* how many are left, on the ring's lower right */
.count {
  position: absolute;
  right: -0.35rem;
  bottom: -0.25rem;
  min-width: 0.85rem;
  height: 0.85rem;
  padding: 0 0.2rem;
  box-sizing: border-box;
  border-radius: 999px;
  background: #8a5cf6;
  color: #fff;
  font-size: 0.55rem;
  font-weight: 700;
  line-height: 0.85rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* appears / goes: pops in and out */
.compress-btn-enter-active,
.compress-btn-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1.3);
}

.compress-btn-enter-from,
.compress-btn-leave-to {
  opacity: 0;
  transform: scale(0.4);
}

@media (prefers-reduced-motion: reduce) {
  .compress-btn.running .ring {
    animation: none;
  }

  .compress-btn-enter-from,
  .compress-btn-leave-to {
    transform: none;
  }
}
</style>
