<script setup lang="ts">
import { computed, inject, onUnmounted, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import MovePicker from '@/components/MovePicker.vue'
import { queueCompress, trashFile } from '@/api'
import { pulseCompress, useCompressQueue } from '@/composables/useCompressQueue'
import { RELOAD_GALLERY_KEY } from '@/composables/useGallery'
import { popupsGone } from '@/composables/usePopupOpen'
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
import { puffAway } from '@/utils/puff'

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
const { activePaths } = useCompressQueue()
/** Of those, the ones not already waiting or compressing */
const compressNew = computed(() => compressible.value.filter((e) => !activePaths.value.has(e.path)))
/** Adding them to the server's compress queue */
const queueing = ref(false)
/** What queueing them did ("3 queued"), on the first row for a moment */
const compressNote = ref<string | null>(null)
let noteTimer: ReturnType<typeof setTimeout> | undefined
/** How long compressNote stays */
const NOTE_MS = 4000

/**
 * Adds the picked videos and photos to the server's compress queue, which
 * works in the background: its progress is in the top bar's compress button
 * (CompressButton.vue). Selection mode stays on
 */
async function compressSelected() {
  if (queueing.value || compressNew.value.length === 0) return
  pulseCompress()
  queueing.value = true
  try {
    const { queued, refused } = await queueCompress([...compressNew.value])
    compressNote.value =
      refused.length === 0
        ? `${queued.length} queued for compressing`
        : `${queued.length} queued · ${refused.length} not: ${refused[0]!.error}`
  } catch (e) {
    compressNote.value = e instanceof Error ? e.message : 'Compressing failed'
  } finally {
    queueing.value = false
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => (compressNote.value = null), NOTE_MS)
  }
}
onUnmounted(() => clearTimeout(noteTimer))

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

/** The files just moved to the trash, whose cards puff away once the prompt is gone */
let trashedPaths: string[] = []

/**
 * Lists the folder again (App), resolving once the grid shows it. Captured
 * now: this bar is gone (selection mode ended) by the time it's called
 */
const reloadGallery = inject(RELOAD_GALLERY_KEY, null)

/** Moves every picked file to the trash, one after another; failures are listed */
async function trashAll() {
  if (trashing.value) return
  trashing.value = true
  trashError.value = null
  trashedCount.value = 0
  trashedPaths = []
  const failed: string[] = []
  // a copy: the listing doesn't change under it meanwhile, but to be sure
  for (const entry of [...props.selected]) {
    try {
      await trashFile(entry.path)
      trashedCount.value++
      trashedPaths.push(entry.path)
    } catch {
      failed.push(entry.name)
    }
  }
  trashing.value = false
  if (failed.length) trashError.value = `Not moved to the trash: ${failed.join(', ')}`
  else {
    confirmingTrash.value = false
    finishTrash()
  }
}

/**
 * Selection mode ends, and once the prompt has faded the trashed files' cards
 * go up in a puff where they were (utils/puff.ts); then the folder lists
 * again without them
 */
function finishTrash() {
  const paths = trashedPaths
  trashedPaths = []
  emit('done')
  if (paths.length === 0) return
  const reload = reloadGallery
  void popupsGone()
    .then(() => puffAway(paths))
    .finally(() => (reload ? reload() : emit('changed')))
}

/**
 * The trash prompt closes. Cancelled before trashing: selection mode stays
 * on. Closed after a trashing where some files failed (the error listed
 * them): it ends, like after one that went through, and the ones that were
 * trashed puff away
 */
function closeTrash() {
  if (trashing.value) return
  confirmingTrash.value = false
  if (trashError.value) finishTrash()
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
      <span v-if="compressNote" class="note">{{ compressNote }}</span>
    </div>

    <!-- Row 2: compress, move -->
    <div class="bar-row">
      <button
        type="button"
        class="bar-button"
        :disabled="compressNew.length === 0 || queueing"
        :aria-label="COMPRESS_LABEL"
        :title="
          compressible.length > 0 && compressNew.length === 0
            ? 'Already in the compress queue'
            : compressible.length === count
            ? 'Save a smaller copy of each selected file, looking the same (in the background)'
            : `Save a smaller copy of the ${compressible.length} selected videos and photos, looking the same, in the background (other files are skipped)`
        "
        @click="compressSelected"
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

/* what the compress button just did, at the row's right end */
.note {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: #b4aec8;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
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
