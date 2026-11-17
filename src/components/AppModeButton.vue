<script setup lang="ts">
import { ref } from 'vue'
import { appMode, toggleAppMode } from '@/appMode'
import { haptic } from '@/utils/haptics'

/**
 * The app mode as a small pill: goon records and shows plays, last viewed
 * and the heatmap; dev neither (src/appMode.ts). A tap switches it, with a
 * tap of haptics: the pill pops bigger for a moment and the old name slides
 * down out of it as the new one slides down in from above. In the top bar
 * and in the viewer (which covers the top bar). Its background is up to the
 * parent: .theme-glass, or the viewer's dark glass on a photo
 */

const button = ref<HTMLButtonElement | null>(null)

/** Every mode's name: the pill is sized to fit the longest (invisible copies in the template) */
const MODE_NAMES = ['Goon', 'Dev']

/** How long the pop and the names' slide take (ms); keep the slide's CSS equal */
const SWITCH_MS = 320

function onClick() {
  haptic('tap')
  toggleAppMode()
  // the pop: a transform, so it takes no room and the bar around it keeps
  // its size; restarted on every tap. None with reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  button.value?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: 0.4 }, { transform: 'scale(1)' }],
    { duration: SWITCH_MS, easing: 'ease-out' },
  )
}
</script>

<template>
  <button
    ref="button"
    type="button"
    class="app-mode"
    :aria-label="appMode === 'goon' ? 'Goon mode' : 'Dev mode'"
    :title="
      appMode === 'goon'
        ? 'Goon mode: views, last viewed and most watched parts are recorded and shown. Tap for dev mode'
        : 'Dev mode: nothing is recorded or shown. Tap for goon mode'
    "
    @click="onClick"
  >
    <!-- both names in the same spot while they slide, clipped by the pill.
         Every mode's name is also there, invisible, so the pill is always as
         wide as the longest one and keeps its size whatever the mode -->
    <span class="names">
      <span v-for="name in MODE_NAMES" :key="name" class="name sizer" aria-hidden="true">
        {{ name }}
      </span>
      <Transition name="mode-slide">
        <span :key="appMode" class="name">{{ appMode === 'goon' ? 'Goon' : 'Dev' }}</span>
      </Transition>
    </span>
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
  /* the sliding names don't show past the pill */
  overflow: hidden;
  /* no grey box flashed over it on a tap (mobile browsers' tap highlight),
     nor a focus ring after a tap; keyboard focus still shows one */
  -webkit-tap-highlight-color: transparent;
}

.app-mode:focus:not(:focus-visible) {
  outline: none;
}

/* the names, stacked in one grid cell */
.names {
  display: grid;
}

.name {
  grid-area: 1 / 1;
  text-align: center;
}

/* takes room, never shows: holds the pill at the longest name's width */
.sizer {
  visibility: hidden;
}

/* the old name slides down out, the new one down in from above */
.mode-slide-enter-active,
.mode-slide-leave-active {
  transition:
    transform 320ms ease-out,
    opacity 320ms ease-out;
}

.mode-slide-enter-from {
  transform: translateY(-110%);
  opacity: 0;
}

.mode-slide-leave-to {
  transform: translateY(110%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .mode-slide-enter-active,
  .mode-slide-leave-active {
    transition: none;
  }
}
</style>
