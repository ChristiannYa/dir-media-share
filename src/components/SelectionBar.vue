<script setup lang="ts">
import { computed, ref } from 'vue'
import CompressDialog from '@/components/CompressDialog.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import MovePicker from '@/components/MovePicker.vue'
import { trashFile } from '@/api'
import { COMPRESS_LABEL } from '@/constants'
import { ICON_COMPRESS, ICON_FOLDER_MOVE, ICON_TRASH } from '@/icons'
import type { Entry } from '@/types'
import { isCompressible } from '@/utils/entry'
import { formatSize } from '@/utils/format'

/**
 * Bar at the bottom of the screen in selection mode: how many files are
 * picked, select all / none, and what to do with them (compress, move, trash).
 */
const props = defineProps<{
  /** The picked files */
  selected: Entry[]
  /** How many files of the folder can be picked */
  selectable: number
}>()
const emit = defineEmits<{
  selectAll: []
  selectNone: []
  /** Leave selection mode */
  done: []
  /** Files were moved, trashed or compressed: list the folder again */
  changed: []
}>()

const count = computed(() => props.selected.length)
const allSelected = computed(() => count.value > 0 && count.value === props.selectable)
const totalSize = computed(() => props.selected.reduce((sum, e) => sum + (e.size ?? 0), 0))

// ── Compress ──
/** The picked videos and photos that can be compressed (other files are skipped) */
const compressible = computed(() => props.selected.filter(isCompressible))
/** The files being compressed; the compress popup is open while set */
const compressing = ref<Entry[] | null>(null)

// ── Move ──
const moving = ref(false)

function onMoved() {
  moving.value = false
  emit('changed')
}

// ── Trash ──
const confirmingTrash = ref(false)
const trashing = ref(false)
const trashedCount = ref(0)
const trashError = ref<string | null>(null)

/** Moves every picked file to the trash, one after another; failures are listed */
async function trashAll() {
  if (trashing.value) return
  trashing.value = true
  trashError.value = null
  trashedCount.value = 0
  const failed: string[] = []
  for (const entry of props.selected) {
    try {
      await trashFile(entry.path)
      trashedCount.value++
    } catch {
      failed.push(entry.name)
    }
  }
  trashing.value = false
  if (trashedCount.value > 0) emit('changed')
  if (failed.length) trashError.value = `Not moved to the trash: ${failed.join(', ')}`
  else confirmingTrash.value = false
}

function closeTrash() {
  if (!trashing.value) confirmingTrash.value = false
}
</script>

<template>
  <div class="selection-bar" role="toolbar" aria-label="Selection">
    <span class="count">
      {{ count }} selected
      <span v-if="count" class="size">· {{ formatSize(totalSize) }}</span>
    </span>
    <button
      type="button"
      class="bar-button"
      :disabled="selectable === 0"
      @click="allSelected ? emit('selectNone') : emit('selectAll')"
    >
      {{ allSelected ? 'Select none' : 'Select all' }}
    </button>

    <span class="spacer" />

    <button
      type="button"
      class="bar-button action"
      :disabled="compressible.length === 0"
      :title="
        compressible.length === count
          ? 'Save a smaller copy of each selected file, looking the same'
          : `Save a smaller copy of the ${compressible.length} selected videos and photos, looking the same (other files are skipped)`
      "
      @click="compressing = [...compressible]"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_COMPRESS" /></svg>
      {{ COMPRESS_LABEL }}
    </button>
    <button
      type="button"
      class="bar-button action"
      :disabled="count === 0"
      title="Move the selection to another folder"
      @click="moving = true"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_FOLDER_MOVE" /></svg>
      Move
    </button>
    <button
      type="button"
      class="bar-button action danger"
      :disabled="count === 0"
      title="Move the selection to the trash"
      @click="confirmingTrash = true"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_TRASH" /></svg>
      Delete
    </button>
    <button type="button" class="bar-button done" @click="emit('done')">Done</button>

    <MovePicker v-if="moving" :entries="selected" @close="moving = false" @moved="onMoved" />

    <!-- a copy of the list: the selection can't change under it while it runs -->
    <CompressDialog
      v-if="compressing"
      :entries="compressing"
      @changed="emit('changed')"
      @close="compressing = null"
    />

    <ModalDialog
      v-if="confirmingTrash"
      :title="`Move ${count} ${count === 1 ? 'file' : 'files'} to the trash?`"
      subtitle="You can restore them from the trash in your file manager."
      :locked="trashing"
      @close="closeTrash"
    >
      <p v-if="trashError" class="error">{{ trashError }}</p>
      <div class="dialog-actions">
        <button type="button" class="dialog-button" :disabled="trashing" @click="closeTrash">
          {{ trashError ? 'Close' : 'Cancel' }}
        </button>
        <button
          v-if="!trashError"
          type="button"
          class="dialog-button danger"
          :disabled="trashing"
          @click="trashAll"
        >
          {{ trashing ? `Moving ${trashedCount + 1} of ${count}…` : 'Move to trash' }}
        </button>
      </div>
    </ModalDialog>
  </div>
</template>

<style scoped>
/* floats at the bottom of the screen, frosted like the top bar */
.selection-bar {
  position: fixed;
  z-index: 20;
  left: 50%;
  /* above the phone's gesture bar */
  bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  width: min(40rem, calc(100% - 2rem));
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--edge);
  border-radius: 1.2rem;
  background:
    linear-gradient(
      90deg,
      rgba(255, 0, 64, calc(0.1 * var(--glass-opacity))),
      rgba(90, 60, 255, calc(0.12 * var(--glass-opacity))) 50%,
      rgba(0, 213, 255, calc(0.08 * var(--glass-opacity)))
    ),
    rgba(12, 11, 18, 0.75);
  backdrop-filter: blur(14px) saturate(140%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 10px 30px rgba(0, 0, 0, 0.45);
  color: #e8e8e8;
}

/* "Glass effect" off: no blur behind it, so it turns nearly solid to stay readable */
:global(html.no-glass) .selection-bar {
  background: rgba(14, 13, 22, 0.96);
}

.count {
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.size {
  color: #8f88aa;
}

.spacer {
  flex: 1;
}

.bar-button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.05);
  box-shadow: var(--edge-shine);
  color: #ddd;
  font-size: 0.82rem;
  cursor: pointer;
}

.bar-button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.bar-button:disabled {
  opacity: 0.4;
  cursor: default;
}

.bar-button svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}

.bar-button.danger {
  color: #f07060;
}

.bar-button.danger:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  color: #ff8a7a;
}

.bar-button.done {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.bar-button.done:hover {
  background: #3b7bf0;
}

/* ── Trash confirmation ── */
.error {
  margin: 0;
  color: #f07060;
  font-size: 0.85rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-button {
  padding: 0.55rem 1rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  cursor: pointer;
}

.dialog-button:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
}

.dialog-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.dialog-button.danger {
  border-color: #c0392b;
  background: #c0392b;
  color: #fff;
}

.dialog-button.danger:hover:not(:disabled) {
  background: #d9493a;
}
</style>
