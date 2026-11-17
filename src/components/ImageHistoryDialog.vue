<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import FramedImage from '@/components/FramedImage.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { deleteAppModeHistoryImage, fetchAppModeHistory, type HistoryImage } from '@/api'
import { haptic } from '@/utils/haptics'

/**
 * Upload, in the app mode image popup (AppModeImageDialog.vue): a new image
 * from this device, or one of the earlier images (the ones replaced or
 * removed, of either mode), round like they showed. Picking hands it to the
 * parent, which saves it. × deletes one for good: a first tap turns it red, a
 * second deletes.
 */
defineProps<{
  /** The parent is saving the pick: everything waits */
  busy?: boolean
  /** Why saving the pick failed */
  error?: string | null
}>()
const emit = defineEmits<{ file: [file: File]; pick: [image: HistoryImage]; close: [] }>()

const MODE_NAMES: Record<string, string> = { goon: 'Goon', dev: 'Dev' }

const images = ref<HistoryImage[]>([])
const loading = ref(true)
const listError = ref<string | null>(null)

onMounted(async () => {
  try {
    images.value = await fetchAppModeHistory()
  } catch (e) {
    listError.value = e instanceof Error ? e.message : 'Loading the earlier images failed'
  } finally {
    loading.value = false
  }
})

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // picking the same file again still counts
  if (file) emit('file', file)
}

function when(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : ''
}

// ── Deleting: two taps on × ──

/** How long a first tap on × waits for the second */
const CONFIRM_MS = 2500

/** The image whose × was tapped once */
const armed = ref<string | null>(null)
let disarm: number | undefined
const deleting = ref<string | null>(null)

async function onDelete(image: HistoryImage) {
  if (deleting.value) return
  if (armed.value !== image.id) {
    haptic('tap')
    armed.value = image.id
    clearTimeout(disarm)
    disarm = window.setTimeout(() => (armed.value = null), CONFIRM_MS)
    return
  }
  clearTimeout(disarm)
  armed.value = null
  deleting.value = image.id
  listError.value = null
  try {
    await deleteAppModeHistoryImage(image.id)
    images.value = images.value.filter((i) => i.id !== image.id)
  } catch (e) {
    listError.value = e instanceof Error ? e.message : 'Deleting failed'
  } finally {
    deleting.value = null
  }
}

onUnmounted(() => clearTimeout(disarm))
</script>

<template>
  <ModalDialog
    title="Choose an image"
    subtitle="A new one, or one used before"
    wide
    :locked="busy"
    @close="emit('close')"
  >
    <div class="tiles" :class="{ busy }">
      <!-- a new image from this device -->
      <label class="tile new">
        <span class="circle new-circle" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
        </span>
        <span class="caption">New image</span>
        <input
          class="file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          :disabled="busy"
          @change="onFilePicked"
        />
      </label>

      <!-- the earlier ones, newest first -->
      <div
        v-for="image in images"
        :key="image.id"
        class="tile"
        :class="{ deleting: deleting === image.id }"
      >
        <button
          type="button"
          class="pick"
          :title="`Use this one (${MODE_NAMES[image.mode] ?? image.mode} until ${when(image.replacedAt)})`"
          :disabled="busy"
          @click="emit('pick', image)"
        >
          <FramedImage class="circle" :src="image.url" :frame="image.frame" />
        </button>
        <span class="caption">{{ MODE_NAMES[image.mode] ?? image.mode }}</span>
        <button
          type="button"
          class="delete"
          :class="{ armed: armed === image.id }"
          :aria-label="armed === image.id ? 'Tap again to delete for good' : 'Delete'"
          :title="armed === image.id ? 'Tap again to delete for good' : 'Delete'"
          :disabled="busy"
          @click="onDelete(image)"
        >
          ✕
        </button>
      </div>
    </div>

    <p v-if="loading" class="note">Loading…</p>
    <p v-else-if="!images.length && !listError" class="note">
      Images you replace or remove show up here, to use again.
    </p>
    <p v-if="listError || error" class="error">{{ error || listError }}</p>
  </ModalDialog>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(5.2rem, 1fr));
  gap: 0.9rem 0.6rem;
  transition: opacity 0.15s;
}

.tiles.busy {
  opacity: 0.5;
  pointer-events: none;
}

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  transition: opacity 0.15s;
}

.tile.deleting {
  opacity: 0.35;
}

.circle {
  width: 4.2rem;
  height: 4.2rem;
  border-radius: 50%;
}

.pick {
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  transition: transform 0.15s;
}

.pick:hover:not(:disabled) {
  transform: scale(1.05);
}

.pick:disabled {
  cursor: default;
}

/* "New image": a dashed circle with a plus */
.tile.new {
  cursor: pointer;
}

.new-circle {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  border: 1.5px dashed var(--edge);
  color: #b4aec8;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.tile.new:hover .new-circle {
  border-color: #2d6cdf;
  color: #fff;
}

.new-circle svg {
  width: 1.6rem;
  height: 1.6rem;
  fill: currentColor;
}

.caption {
  color: #8f88aa;
  font-size: 0.7rem;
}

/* × on the circle's top right; red once tapped, waiting for the second tap */
.delete {
  position: absolute;
  top: -0.2rem;
  right: calc(50% - 2.4rem);
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: 1px solid var(--edge);
  border-radius: 50%;
  background: rgba(22, 21, 28, 0.95);
  color: #aaa;
  font-size: 0.6rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    transform 0.15s;
}

.delete:hover:not(:disabled) {
  color: #fff;
}

.delete.armed {
  border-color: #c0392b;
  background: #c0392b;
  color: #fff;
  transform: scale(1.15);
}

/* the label is the tile; the input itself stays out of sight */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.note {
  margin: 0;
  color: #8f88aa;
  font-size: 0.78rem;
  text-align: center;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
}
</style>
