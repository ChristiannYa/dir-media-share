<script setup lang="ts">
import { ref } from 'vue'
import FramedImage from '@/components/FramedImage.vue'
import ModeImageFrameDialog from '@/components/ModeImageFrameDialog.vue'
import { saveAppModeFrame, uploadAppModeImage, type ImageFrame } from '@/api'
import type { AppMode } from '@/appMode'
import {
  APP_MODES,
  refreshAppModeImages,
  shownModeImage,
  useAppModeImages,
} from '@/composables/useAppModeImages'

/**
 * Settings → App → App mode images: per mode, the image beside the app mode
 * pill (AppModeButton.vue) and the round part of it that shows. Upload picks
 * a new one and opens the frame right away; Adjust frame moves the frame of
 * the one it has. Use in the frame saves it on the server right away (not
 * with Done: an image is a file, not a value), and every pill shows it.
 */

const images = useAppModeImages()

const LABELS: Record<AppMode, { name: string; help: string }> = {
  goon: { name: 'Goon', help: 'Beside the badge in goon mode.' },
  dev: { name: 'Dev', help: 'Beside the badge in dev mode.' },
}

// ── The frame dialog ──

const editing = ref<{
  mode: AppMode
  src: string
  frame: ImageFrame | null
  /** Set when it's a new upload (src is then a preview URL of it) */
  file?: File
} | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

function open(next: NonNullable<typeof editing.value>) {
  error.value = null
  editing.value = next
}

function onFilePicked(mode: AppMode, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // picking the same file again still counts
  if (!file) return
  open({ mode, src: URL.createObjectURL(file), frame: null, file })
}

function adjust(mode: AppMode) {
  const current = images[mode]
  if (current) open({ mode, src: current.src, frame: current.frame })
}

/** Use: saves the new image (if any) and the frame, then closes */
async function onUse(frame: ImageFrame) {
  const e = editing.value
  if (!e || saving.value) return
  saving.value = true
  error.value = null
  try {
    if (e.file) await uploadAppModeImage(e.mode, e.file)
    await saveAppModeFrame(e.mode, frame)
    await refreshAppModeImages()
    closeDialog()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Saving failed'
  } finally {
    saving.value = false
  }
}

function closeDialog() {
  const e = editing.value
  if (e?.file) URL.revokeObjectURL(e.src)
  editing.value = null
}
</script>

<template>
  <div v-for="mode in APP_MODES" :key="mode" class="field">
    <FramedImage
      v-if="shownModeImage(mode)"
      class="thumb"
      :src="shownModeImage(mode)!.src"
      :frame="shownModeImage(mode)!.frame"
    />
    <span v-else class="thumb empty" aria-hidden="true" />

    <div class="field-text">
      <span class="label">{{ LABELS[mode].name }}</span>
      <p class="help">
        {{ LABELS[mode].help }}
        <template v-if="!images[mode]">
          {{ shownModeImage(mode) ? 'None uploaded: shows this built-in one.' : 'No image yet.' }}
        </template>
      </p>
    </div>

    <div class="buttons">
      <label class="button small">
        Upload
        <input
          class="file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          @change="onFilePicked(mode, $event)"
        />
      </label>
      <button
        type="button"
        class="button small"
        :disabled="!images[mode]"
        @click="adjust(mode)"
      >
        Adjust frame
      </button>
    </div>
  </div>

  <ModeImageFrameDialog
    v-if="editing"
    :title="`${LABELS[editing.mode].name} image`"
    :src="editing.src"
    :frame="editing.frame"
    :saving="saving"
    :error="error"
    @use="onUse"
    @close="closeDialog"
  />
</template>

<style scoped>
/* a setting row (SettingRow.vue) */
.field {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--edge-soft);
  border-left: 3px solid transparent;
  border-radius: 0.7rem;
  background: rgba(255, 255, 255, 0.035);
}

/* round, like beside the badge */
.thumb {
  flex: none;
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
}

.thumb.empty {
  border: 1px dashed var(--edge);
}

.field-text {
  flex: 1;
  min-width: 0;
}

.label {
  font-size: 0.86rem;
  color: #e4e4e4;
}

.help {
  margin: 0.15rem 0 0;
  color: #807a92;
  font-size: 0.72rem;
  line-height: 1.4;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.35rem;
}

/* ── Buttons (as in SettingsDialog) ── */
.button {
  position: relative;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  font-size: 0.8rem;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
}

.button:disabled {
  opacity: 0.4;
  cursor: default;
}

/* the label is the button; the input itself stays out of sight */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

@media (max-width: 480px) {
  .field {
    flex-wrap: wrap;
  }

  .field-text {
    flex-basis: calc(100% - 3.5rem);
  }

  .buttons {
    flex-basis: 100%;
  }
}
</style>
