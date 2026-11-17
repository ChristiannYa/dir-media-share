<script setup lang="ts">
import { computed } from 'vue'
import type { ImageFrame } from '@/api'

/**
 * Shows only the framed square part of an image, filling the element (which
 * the parent sizes, as a square). The image is scaled and moved so the frame
 * fills it, and the rest is clipped: nothing is cut out of the file, so a GIF
 * keeps moving. Without a frame, the biggest centered square.
 */
const props = defineProps<{
  src: string
  frame: ImageFrame | null
}>()

const style = computed(() => {
  const f = props.frame
  if (!f) return { inset: '0', width: '100%', height: '100%', objectFit: 'cover' as const }
  return {
    width: `${100 / f.w}%`,
    height: `${100 / f.h}%`,
    left: `${(-f.x / f.w) * 100}%`,
    top: `${(-f.y / f.h) * 100}%`,
  }
})
</script>

<template>
  <span class="framed">
    <img :src="src" :style="style" alt="" draggable="false" />
  </span>
</template>

<style scoped>
.framed {
  position: relative;
  display: block;
  overflow: hidden;
}

.framed img {
  position: absolute;
  max-width: none;
  -webkit-user-select: none;
  user-select: none;
  pointer-events: none;
}
</style>
