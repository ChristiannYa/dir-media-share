<script setup lang="ts">
import { computed } from 'vue'
import { BG_BUBBLE_COLORS } from '@/constants'
import { settings } from '@/settings'

/**
 * Soft colored blobs drifting behind the gallery, so the frosted glass of the
 * folder cards and the top bar has something to blur. Not circles: each is a
 * stretched ellipse fading out from its center, and it turns and squashes as
 * it moves, so its outline keeps changing.
 *
 * Every bubble gets its own random size, color, starting point, path and pace
 * when the page loads, and again whenever a bubble setting changes (Settings →
 * Background). The animation itself is plain CSS (one shared keyframes, fed
 * by each bubble's variables), so nothing runs in JS per frame.
 */

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** A random value of ±`max`, as a CSS length with `unit` */
function offset(max: number, unit: string): string {
  return `${rand(-max, max).toFixed(1)}${unit}`
}

/** The bubble settings; min and max are swapped if entered the wrong way round */
const options = computed(() => ({
  count: settings.bubbleCount,
  minSize: Math.min(settings.bubbleMinSize, settings.bubbleMaxSize),
  maxSize: Math.max(settings.bubbleMinSize, settings.bubbleMaxSize),
  minOpacity: Math.min(settings.bubbleMinOpacity, settings.bubbleMaxOpacity),
  maxOpacity: Math.max(settings.bubbleMinOpacity, settings.bubbleMaxOpacity),
  travel: settings.bubbleTravel,
}))

type Options = typeof options.value

function makeBubble(o: Options) {
  const size = rand(o.minSize, o.maxSize)
  // wider than tall, or the other way round: an ellipse, never a circle
  const stretch = rand(0.6, 1.4)
  const color = BG_BUBBLE_COLORS[Math.floor(Math.random() * BG_BUBBLE_COLORS.length)] ?? '#5a3cff'
  // slow ones and quick ones, relative to --bg-drift-duration
  const pace = rand(0.8, 2)
  return {
    width: `${(size * stretch).toFixed(1)}vmax`,
    height: `${(size / stretch).toFixed(1)}vmax`,
    // centered on a random point of the screen
    left: `calc(${rand(0, 100).toFixed(1)}% - ${((size * stretch) / 2).toFixed(1)}vmax)`,
    top: `calc(${rand(0, 100).toFixed(1)}% - ${((size / stretch) / 2).toFixed(1)}vmax)`,
    opacity: rand(o.minOpacity, o.maxOpacity).toFixed(2),
    background: `radial-gradient(closest-side, ${color}, transparent)`,
    // waypoints of its path (see @keyframes bubble-float)
    '--dx1': offset(o.travel, 'vw'),
    '--dy1': offset(o.travel, 'vh'),
    '--dx2': offset(o.travel, 'vw'),
    '--dy2': offset(o.travel, 'vh'),
    '--dx3': offset(o.travel, 'vw'),
    '--dy3': offset(o.travel, 'vh'),
    '--r1': offset(60, 'deg'),
    '--r2': offset(120, 'deg'),
    '--r3': offset(180, 'deg'),
    '--s1': rand(0.8, 1.25).toFixed(2),
    '--s2': rand(0.8, 1.25).toFixed(2),
    '--pace': pace.toFixed(2),
    // starts somewhere along its path, so they don't all set off together
    '--start': (-rand(0, pace)).toFixed(2),
  }
}

// re-rolled only when a bubble setting changes, not on every render
const bubbles = computed(() => {
  const o = options.value
  return Array.from({ length: o.count }, () => makeBubble(o))
})
</script>

<template>
  <div class="bubbles" aria-hidden="true">
    <div v-for="(style, i) in bubbles" :key="i" class="bubble" :style="style" />
  </div>
</template>

<style scoped>
/* fixed behind the page content, like the colored glows (App.vue) */
.bubbles {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
  /* "Background brightness" setting (--bg-brightness in styles/tokens.css) */
  filter: brightness(var(--bg-brightness));
}

.bubble {
  position: absolute;
  will-change: transform;
  /* --bg-drift-duration: 0s stops them, like the glows */
  animation: bubble-float calc(var(--bg-drift-duration) * var(--pace)) ease-in-out
    calc(var(--bg-drift-duration) * var(--start)) infinite alternate;
}

/* Wanders through three random points, turning and squashing on the way */
@keyframes bubble-float {
  0% {
    transform: translate(0, 0) rotate(0deg) scale(1, 1);
  }
  33% {
    transform: translate(var(--dx1), var(--dy1)) rotate(var(--r1)) scale(var(--s1), var(--s2));
  }
  66% {
    transform: translate(var(--dx2), var(--dy2)) rotate(var(--r2)) scale(var(--s2), var(--s1));
  }
  100% {
    transform: translate(var(--dx3), var(--dy3)) rotate(var(--r3)) scale(1, 1);
  }
}
</style>
