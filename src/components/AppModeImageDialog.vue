<script setup lang="ts">
import { computed, ref } from 'vue'
import FramedImage from '@/components/FramedImage.vue'
import ImageHistoryDialog from '@/components/ImageHistoryDialog.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import ModeImageFrameDialog from '@/components/ModeImageFrameDialog.vue'
import {
  removeAppModeImage,
  restoreAppModeImage,
  saveAppModeFrame,
  uploadAppModeImage,
  type HistoryImage,
  type ImageFrame,
} from '@/api'
import type { AppMode } from '@/appMode'
import {
  appModeImages,
  refreshAppModeImages,
  shownModeImage,
} from '@/composables/useAppModeImages'

/**
 * Opens on a tap on the image beside the app mode pill (AppModeButton.vue),
 * for the mode on now. Shows its image, round as beside the pill, and:
 * - Upload: a popup with a new image from this device and the earlier ones
 *   (ImageHistoryDialog.vue); a new one then opens the frame
 * - Adjust frame: the round part that shows (ModeImageFrameDialog.vue)
 * - Remove: back to none (dev: the built-in code icon)
 * Every change is saved right away; the image it replaces goes to the
 * history (server/handlers/appModeImage.ts), so it can be picked again.
 * Like every popup, the top bar and the alphabet bar slide away meanwhile.
 */
const props = defineProps<{ mode: AppMode }>()
const emit = defineEmits<{ close: [] }>()

const NAMES: Record<AppMode, string> = { goon: 'Goon', dev: 'Dev' }
const name = computed(() => NAMES[props.mode])

/** Its own image (uploaded); null if none */
const own = computed(() => appModeImages[props.mode])
/** What shows beside the pill: its own image, or the built-in one */
const shown = computed(() => shownModeImage(props.mode))

const busy = ref(false)
const error = ref<string | null>(null)

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

// ── Remove ──

async function remove() {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await removeAppModeImage(props.mode)
    await refreshAppModeImages()
  } catch (e) {
    error.value = message(e, 'Removing failed')
  } finally {
    busy.value = false
  }
}

// ── Upload: a new one, or one from the history ──

const historyOpen = ref(false)
const historyError = ref<string | null>(null)

function openHistory() {
  historyError.value = null
  historyOpen.value = true
}

async function onPick(image: HistoryImage) {
  if (busy.value) return
  busy.value = true
  historyError.value = null
  try {
    await restoreAppModeImage(props.mode, image.id)
    await refreshAppModeImages()
    historyOpen.value = false
  } catch (e) {
    historyError.value = message(e, 'Using that image failed')
  } finally {
    busy.value = false
  }
}

function onFile(file: File) {
  historyOpen.value = false
  openFrame({ src: URL.createObjectURL(file), frame: null, file })
}

// ── The frame ──

const framing = ref<{
  src: string
  frame: ImageFrame | null
  /** Set for a new image (src is then a preview URL of it) */
  file?: File
} | null>(null)
const frameError = ref<string | null>(null)

function openFrame(next: NonNullable<typeof framing.value>) {
  frameError.value = null
  framing.value = next
}

function adjust() {
  if (own.value) openFrame({ src: own.value.src, frame: own.value.frame })
}

/** Use: saves the new image (if any) and the frame */
async function onUse(frame: ImageFrame) {
  const f = framing.value
  if (!f || busy.value) return
  busy.value = true
  frameError.value = null
  try {
    if (f.file) await uploadAppModeImage(props.mode, f.file)
    await saveAppModeFrame(props.mode, frame)
    await refreshAppModeImages()
    closeFrame()
  } catch (e) {
    frameError.value = message(e, 'Saving failed')
  } finally {
    busy.value = false
  }
}

function closeFrame() {
  if (framing.value?.file) URL.revokeObjectURL(framing.value.src)
  framing.value = null
}
</script>

<template>
  <ModalDialog
    :title="`${name} image`"
    :subtitle="`Beside the badge in ${name.toLowerCase()} mode, on every device`"
    :locked="busy"
    @close="emit('close')"
  >
    <div class="current">
      <FramedImage v-if="shown" class="big" :src="shown.src" :frame="shown.frame" />
      <span v-else class="big empty" aria-hidden="true" />
      <p v-if="!own" class="note">
        {{ shown ? 'The built-in one: none uploaded.' : 'No image yet.' }}
      </p>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button
        v-if="own"
        type="button"
        class="button ghost"
        title="It goes to the earlier images, to use again"
        :disabled="busy"
        @click="remove"
      >
        Remove
      </button>
      <span class="spacer" />
      <button type="button" class="button" :disabled="!own || busy" @click="adjust">
        Adjust frame
      </button>
      <button type="button" class="button primary" :disabled="busy" @click="openHistory">
        Upload
      </button>
    </div>
  </ModalDialog>

  <ImageHistoryDialog
    v-if="historyOpen"
    :busy="busy"
    :error="historyError"
    @file="onFile"
    @pick="onPick"
    @close="historyOpen = false"
  />

  <ModeImageFrameDialog
    v-if="framing"
    :title="`${name} image`"
    :src="framing.src"
    :frame="framing.frame"
    :saving="busy"
    :error="frameError"
    @use="onUse"
    @close="closeFrame"
  />
</template>

<style scoped>
.current {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0;
}

/* round, like beside the badge */
.big {
  width: 7rem;
  height: 7rem;
  border-radius: 50%;
}

.big.empty {
  box-sizing: border-box;
  border: 1.5px dashed var(--edge);
}

.note {
  margin: 0;
  color: #8f88aa;
  font-size: 0.75rem;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
}

/* ── Buttons (as in SettingsDialog) ── */
.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spacer {
  flex: 1;
}

.button {
  padding: 0.55rem 1rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
}

.button.ghost {
  border-color: transparent;
  background: none;
  box-shadow: none;
  color: #999;
  font-size: 0.8rem;
}

.button.ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}

.button.primary {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.button.primary:hover:not(:disabled) {
  background: #3b7bf0;
}

.button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
