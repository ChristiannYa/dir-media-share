<script setup lang="ts">
import { computed, ref } from 'vue'
import AppModeImageDialog from '@/components/AppModeImageDialog.vue'
import FramedImage from '@/components/FramedImage.vue'
import { appMode } from '@/appMode'
import { APP_MODES, shownModeImage, useAppModeImages } from '@/composables/useAppModeImages'
import { haptic } from '@/utils/haptics'

/**
 * The current app mode's small round image, showing only its framed part. In
 * the top bar (left of the settings button) and in the viewer, beside the
 * mode pill (AppModeButton.vue). `editable` (the top bar): a tap opens the
 * popup that changes it (AppModeImageDialog.vue); a mode without one then
 * shows an empty dashed circle to tap.
 */
defineProps<{ editable?: boolean }>()

useAppModeImages()

/** The popup that changes the current mode's image */
const dialogOpen = ref(false)

function openDialog() {
  haptic('tap')
  dialogOpen.value = true
}

/** The current mode shows an image (its own or a built-in one) */
const hasImage = computed(() => shownModeImage(appMode.value) !== null)

/** The modes that have an image (their own or a built-in one), with it */
const modeImages = computed(() =>
  APP_MODES.flatMap((mode) => {
    const image = shownModeImage(mode)
    return image ? [{ mode, ...image }] : []
  }),
)
</script>

<template>
  <!-- every mode's image is loaded, stacked; the current one shows, so a
       switch never waits for one to load. A mode without one shows nothing
       (editable: an empty dashed circle). Editable: a button opening the popup -->
  <component
    :is="editable ? 'button' : 'span'"
    :type="editable ? 'button' : undefined"
    class="mode-image"
    :class="{ editable, empty: !hasImage }"
    :aria-label="editable ? `Change the ${appMode} mode image` : undefined"
    :aria-hidden="editable ? undefined : 'true'"
    :title="editable ? 'Change this image' : undefined"
    @click="editable && openDialog()"
  >
    <FramedImage
      v-for="image in modeImages"
      :key="image.mode"
      class="image"
      :class="{ shown: image.mode === appMode }"
      :src="image.src"
      :frame="image.frame"
    />
  </component>
  <AppModeImageDialog v-if="dialogOpen" :mode="appMode" @close="dialogOpen = false" />
</template>

<style scoped>
/* the images, stacked in one square; the current one fades in. Its size can
   be set by the parent (the viewer: the height of the pills beside it) */
.mode-image {
  display: grid;
  flex-shrink: 0;
  width: var(--mode-image-size, 1.6rem);
  height: var(--mode-image-size, 1.6rem);
}

/* round: FramedImage clips the image to it */
.image {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  opacity: 0;
  transition: opacity 320ms ease-out;
}

.image.shown {
  opacity: 1;
}

/* the top bar's: a round button with no look of its own but the image */
.mode-image.editable {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.15s;
}

.mode-image.editable:hover {
  transform: scale(1.08);
}

.mode-image.editable:active {
  transform: scale(0.94);
}

.mode-image.editable:focus:not(:focus-visible) {
  outline: none;
}

/* no image for this mode: something to tap */
.mode-image.editable.empty {
  border: 1.5px dashed rgba(255, 255, 255, 0.45);
}
</style>
