<script setup lang="ts">
import { computed, ref } from 'vue'
import CompressDialog from '@/components/CompressDialog.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import MovePicker from '@/components/MovePicker.vue'
import { trashFile } from '@/api'
import { COMPRESS_LABEL } from '@/constants'
import {
  ICON_CHECK,
  ICON_CLOSE,
  ICON_COMPRESS,
  ICON_FOLDER_MOVE,
  ICON_SELECT_ALL,
  ICON_SELECT_NONE,
  ICON_TRASH,
} from '@/icons'
import type { Entry } from '@/types'
import { isCompressible } from '@/utils/entry'
import { formatSize } from '@/utils/format'

/**
 * Bar at the bottom of the screen in selection mode (turned on from a file's
 * menu: FileMenu.vue). Icon buttons only (their names are in their titles),
 * in three rows:
 *  1. how many files are picked, and their size
 *  2. compress, move
 *  3. on the left delete and cancel, on the right select all / none and done
 *
 * Selection mode ends (`done`, which also drops the picks) on cancel, done,
 * and once a move or a trashing went through. A move picker or trash prompt
 * closed without doing anything keeps it on; compressing keeps it on too.
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
  /** Leave selection mode, dropping the picks (cancel, done, after a move or trashing) */
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
  emit('done')
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
  else {
    confirmingTrash.value = false
    emit('done')
  }
}

/**
 * The trash prompt closes. Cancelled before trashing: selection mode stays
 * on. Closed after a trashing where some files failed (the error listed
 * them): it ends, like after one that went through
 */
function closeTrash() {
  if (trashing.value) return
  confirmingTrash.value = false
  if (trashError.value) emit('done')
  trashError.value = null
}
</script>

<template>
  <div class="selection-bar" role="toolbar" aria-label="Selection">
    <!-- Row 1: how many are picked, and their size -->
    <div class="bar-row">
      <span class="count">
        {{ count }} selected
        <span v-if="count" class="size">· {{ formatSize(totalSize) }}</span>
      </span>
    </div>

    <!-- Row 2: compress, move -->
    <div class="bar-row">
      <button
        type="button"
        class="bar-button"
        :disabled="compressible.length === 0"
        :aria-label="COMPRESS_LABEL"
        :title="
          compressible.length === count
            ? 'Save a smaller copy of each selected file, looking the same'
            : `Save a smaller copy of the ${compressible.length} selected videos and photos, looking the same (other files are skipped)`
        "
        @click="compressing = [...compressible]"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_COMPRESS" /></svg>
      </button>
      <button
        type="button"
        class="bar-button"
        :disabled="count === 0"
        aria-label="Move"
        title="Move the selection to another folder"
        @click="moving = true"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_FOLDER_MOVE" /></svg>
      </button>
    </div>

    <!-- Row 3: delete and cancel on the left; select all / none and done on the right -->
    <div class="bar-row">
      <div class="group">
        <button
          type="button"
          class="bar-button danger"
          :disabled="count === 0"
          aria-label="Delete"
          title="Move the selection to the trash"
          @click="confirmingTrash = true"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_TRASH" /></svg>
        </button>
        <button
          type="button"
          class="bar-button"
          aria-label="Cancel"
          title="Unselect everything and leave selection mode"
          @click="emit('done')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_CLOSE" /></svg>
        </button>
      </div>

      <span class="spacer" />

      <div class="group">
        <button
          type="button"
          class="bar-button"
          :disabled="selectable === 0"
          :aria-label="allSelected ? 'Select none' : 'Select all'"
          :title="allSelected ? 'Select none' : 'Select all'"
          @click="allSelected ? emit('selectNone') : emit('selectAll')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path :d="allSelected ? ICON_SELECT_NONE : ICON_SELECT_ALL" />
          </svg>
        </button>
        <button
          type="button"
          class="bar-button done"
          aria-label="Done"
          title="Leave selection mode"
          @click="emit('done')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON_CHECK" /></svg>
        </button>
      </div>
    </div>

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
  flex-direction: column;
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

/* one row of the bar (see the script's comment) */
.bar-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* buttons kept together in a row (delete + cancel, select all + done) */
.group {
  display: flex;
  gap: 0.5rem;
}

.count {
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.size {
  color: #8f88aa;
}

/* pushes the right group to the row's end */
.spacer {
  flex: 1;
}

/* icon only: a fixed square, the same for every button of the bar (about
   4px bigger than the icon + padding they had) */
.bar-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 2.6rem;
  height: 2.6rem;
  padding: 0;
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
  width: 1.15rem;
  height: 1.15rem;
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
