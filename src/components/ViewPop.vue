<script setup lang="ts">
import { onMounted } from 'vue'
import { ICON_EYE } from '@/icons'
import { viewHaptic } from '@/utils/haptics'

/**
 * The "+1" eye shown when a view counts (a video watched long enough, a photo
 * seen long enough: VideoPlayer.vue, MediaLightbox.vue): it pops in from a
 * blur somewhere random over the media, overshoots, floats up and fades, with
 * a ring swelling out from it and sparks flying off, and a double buzz of
 * haptics. Never in the way: no pointer events.
 *
 * Its size follows the screen's width (--view-pop-size below): small on a
 * phone, bigger on a large screen. It's placed inside `--media-inset-x / -y`
 * (set by a parent: the bands a differently shaped picture leaves around it in
 * fullscreen, useContainedInset.ts), so it lands on the picture itself.
 * `done` when its animation ends.
 */
const emit = defineEmits<{ done: [] }>()

/** Most it's tilted either way (deg): it stays readable without turning the phone */
const MAX_TILT_DEG = 25

// somewhere random over the media, clear of its edges and of the controls at the bottom
const at = {
  left: `${15 + Math.random() * 70}%`,
  top: `${25 + Math.random() * 45}%`,
  // a playful tilt, never so far that it has to be read sideways
  '--tilt': `${(Math.random() * 2 - 1) * MAX_TILT_DEG}deg`,
}

onMounted(viewHaptic)
</script>

<template>
  <div class="view-pop-area" aria-hidden="true">
    <div class="view-pop" :style="at" @animationend.self="emit('done')">
      <span class="view-pop-ring" />
      <span v-for="i in 8" :key="i" class="view-pop-spark" :style="{ '--angle': `${i * 45}deg` }" />
      <span class="view-pop-badge">
        <svg viewBox="0 0 24 24">
          <defs>
            <linearGradient id="view-pop-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" style="stop-color: var(--theme-cyan)" />
              <stop offset="0.5" style="stop-color: var(--theme-blue)" />
              <stop offset="1" style="stop-color: var(--theme-pink)" />
            </linearGradient>
          </defs>
          <path :d="ICON_EYE" fill="url(#view-pop-gradient)" />
        </svg>
        <span class="view-pop-text">+1</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* the picture's box, inside the bands around it (none unless in fullscreen) */
.view-pop-area {
  position: absolute;
  z-index: 6;
  top: var(--media-inset-y, 0px);
  bottom: var(--media-inset-y, 0px);
  left: var(--media-inset-x, 0px);
  right: var(--media-inset-x, 0px);
  pointer-events: none;
}

/* Pops in from a blur at the random place (left / top set by the script),
   overshoots, then floats up and fades. All its sizes are in em of this one:
   16px on a phone, up to about 35px on a very large screen */
.view-pop {
  --view-pop-size: clamp(1rem, 0.5rem + 0.65vw, 2.2rem);
  position: absolute;
  font-size: var(--view-pop-size);
  display: grid;
  place-items: center;
  pointer-events: none;
  animation: view-pop-rise 2s cubic-bezier(0.2, 0.75, 0.25, 1) forwards;
}

/* tilted by --tilt (random, set by the script); the rise above stays straight up */
.view-pop-badge {
  transform: rotate(var(--tilt, 0deg));
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.3em 0.65em 0.3em 0.5em;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  background: rgba(10, 8, 22, 0.45);
  -webkit-backdrop-filter: blur(8px) saturate(160%);
  backdrop-filter: blur(8px) saturate(160%);
  box-shadow:
    0 0 0.8em 0.15em color-mix(in srgb, var(--theme-cyan) 45%, transparent),
    0 0 1.7em 0.4em color-mix(in srgb, var(--theme-purple) 30%, transparent);
}

.view-pop-badge svg {
  width: 1.25em;
  height: 1.25em;
  filter: drop-shadow(0 0 0.25em color-mix(in srgb, var(--theme-cyan) 80%, transparent));
}

.view-pop-text {
  font-size: 0.9em;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(90deg, var(--theme-cyan), var(--theme-blue), var(--theme-pink));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

/* a ring in the theme colors swelling out from the badge as it lands */
.view-pop-ring {
  position: absolute;
  width: 2.4em;
  height: 2.4em;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--theme-cyan) 85%, transparent);
  box-shadow: 0 0 0.65em color-mix(in srgb, var(--theme-blue) 70%, transparent);
  opacity: 0;
  animation: view-pop-ring 0.9s ease-out 0.2s forwards;
}

/* little sparks flying off all around */
.view-pop-spark {
  position: absolute;
  width: 0.2em;
  height: 0.2em;
  min-width: 3px;
  min-height: 3px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0.3em 0.06em color-mix(in srgb, var(--theme-cyan) 80%, transparent);
  opacity: 0;
  animation: view-pop-spark 0.8s ease-out 0.22s forwards;
}

.view-pop-spark:nth-child(odd) {
  box-shadow: 0 0 0.3em 0.06em color-mix(in srgb, var(--theme-pink) 80%, transparent);
}

@keyframes view-pop-rise {
  0% {
    opacity: 0;
    transform: translate(-50%, -20%) scale(0.5);
    filter: blur(8px);
  }
  14% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.15);
    filter: blur(0);
  }
  24% {
    transform: translate(-50%, -50%) scale(0.97);
  }
  32% {
    transform: translate(-50%, -52%) scale(1);
  }
  72% {
    opacity: 1;
    transform: translate(-50%, -120%) scale(1);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -170%) scale(0.92);
    filter: blur(4px);
  }
}

@keyframes view-pop-ring {
  0% {
    opacity: 0.9;
    transform: scale(0.8);
  }
  100% {
    opacity: 0;
    transform: scale(2.6);
  }
}

@keyframes view-pop-spark {
  0% {
    opacity: 1;
    transform: rotate(var(--angle)) translateX(0.5em) scale(1);
  }
  100% {
    opacity: 0;
    transform: rotate(var(--angle)) translateX(2.2em) scale(0.3);
  }
}

/* reduced motion: it just fades in and out where it is */
@media (prefers-reduced-motion: reduce) {
  .view-pop {
    transform: translate(-50%, -50%);
    animation: view-pop-fade 1.6s ease-in-out forwards;
  }

  .view-pop-ring,
  .view-pop-spark {
    display: none;
  }
}

@keyframes view-pop-fade {
  0%,
  100% {
    opacity: 0;
  }
  20%,
  70% {
    opacity: 1;
  }
}
</style>
