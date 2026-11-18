<script setup lang="ts">
/**
 * Glowing dots running along the parent's rounded border, slowly fading
 * through the theme colors (tokens.css) as they go. Each time it appears it
 * starts at a random point and runs in a random direction (several dots stay
 * evenly spaced from that point, each at a different color).
 */
defineProps<{ count: number }>()

/** Where along the border the first dot starts: 0–1 of one lap */
const start = Math.random()
const reverse = Math.random() < 0.5
</script>

<template>
  <div class="dots" :class="{ reverse }" :style="{ '--n': count, '--start': start }">
    <span v-for="i in count" :key="i" class="dot" :style="{ '--i': i - 1 }" />
  </div>
</template>

<style scoped>
/* registered, so it can be animated: the dot fades from one color to the next */
@property --dot-color {
  syntax: '<color>';
  inherits: false;
  initial-value: #8b5cff;
}

.dots {
  --lap: 2.4s; /* time for one full lap */
  position: absolute;
  /* the middle of the ring (styles/ring.css), just inside the card's edge */
  inset: calc(var(--ring-width) / 2);
  z-index: 2;
  pointer-events: none;
}

.dot {
  position: absolute;
  top: 0;
  left: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dot-color);
  box-shadow:
    0 0 6px 2px var(--dot-color),
    0 0 14px 4px var(--dot-color);
  offset-path: inset(
    0 round max(0px, calc(var(--card-radius) - var(--card-border) - var(--ring-width) / 2))
  );
  offset-anchor: 50% 50%;
  offset-rotate: 0deg;
  /* runs around the border; fades through the theme colors every two laps */
  animation:
    dot-run var(--lap) linear infinite,
    dot-colors calc(2 * var(--lap)) linear infinite;
  /* a negative delay starts part-way: a random start, then evenly spaced
     (also in color, so several dots aren't all the same one) */
  animation-delay:
    calc((var(--start) + var(--i) / var(--n)) * -1 * var(--lap)),
    calc((var(--start) + var(--i) / var(--n)) * -2 * var(--lap));
}

.dots.reverse .dot {
  animation-direction: reverse, normal;
}

@keyframes dot-run {
  from {
    offset-distance: 0%;
  }
  to {
    offset-distance: 100%;
  }
}

/* the ring's theme colors (tokens.css), in the same order */
@keyframes dot-colors {
  0%,
  100% {
    --dot-color: var(--theme-purple);
  }
  20% {
    --dot-color: var(--theme-blue);
  }
  40% {
    --dot-color: var(--theme-cyan);
  }
  60% {
    --dot-color: var(--theme-green);
  }
  80% {
    --dot-color: var(--theme-pink);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dots {
    display: none;
  }
}
</style>
