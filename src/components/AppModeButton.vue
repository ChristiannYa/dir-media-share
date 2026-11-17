<script setup lang="ts">
import { appMode, toggleAppMode } from '@/appMode'

/**
 * The app mode as a small pill: goon records and shows plays, last viewed
 * and the heatmap; dev neither (src/appMode.ts). A tap switches it. In the
 * top bar and in the viewer (which covers the top bar). Its background is up
 * to the parent: .theme-glass, or the viewer's dark glass on a photo
 */
</script>

<template>
  <button
    type="button"
    class="app-mode"
    :title="
      appMode === 'goon'
        ? 'Goon mode: views, last viewed and most watched parts are recorded and shown. Tap for dev mode'
        : 'Dev mode: nothing is recorded or shown. Tap for goon mode'
    "
    @click="toggleAppMode"
  >
    {{ appMode === 'goon' ? 'Goon' : 'Dev' }}
  </button>
</template>

<style scoped>
.app-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
  cursor: pointer;
}
</style>
