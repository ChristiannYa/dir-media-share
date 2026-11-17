<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { fetchFolders, moveFile } from '@/api'
import type { Entry, FolderRef } from '@/types'

/**
 * Dialog to pick a folder (anywhere in the shared folder) and move one or
 * more files there (all from the same folder). Starts in their own folder.
 * A ModalDialog, like every popup (its look, Escape, a tap outside)
 */
const props = defineProps<{ entries: Entry[] }>()
/** `moved`: at least one file was moved, so the listing should be reloaded */
const emit = defineEmits<{ close: []; moved: [] }>()

function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

const fromDir = parentOf(props.entries[0]?.path ?? '')
/** What the title calls them: the file's name, or "3 files" */
const what = computed(() =>
  props.entries.length === 1 ? (props.entries[0]?.name ?? '') : `${props.entries.length} files`,
)
/** How many are moved so far, while moving several */
const movedCount = ref(0)
/** Folder currently shown in the picker ('' = the shared folder itself) */
const dir = ref(fromDir)
const folders = ref<FolderRef[]>([])
const loading = ref(false)
const moving = ref(false)
const error = ref<string | null>(null)

const crumbs = computed(() =>
  dir.value
    .split('/')
    .filter(Boolean)
    .map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })),
)
const isSameFolder = computed(() => dir.value === fromDir)

async function open(path: string) {
  dir.value = path
  error.value = null
  loading.value = true
  try {
    folders.value = await fetchFolders(path)
  } catch {
    folders.value = []
    error.value = 'Could not load folders'
  } finally {
    loading.value = false
  }
}

/**
 * Moves every file, one after another. Those that fail stay where they are;
 * the dialog then stays open and says which
 */
async function moveHere() {
  if (moving.value || isSameFolder.value) return
  moving.value = true
  error.value = null
  movedCount.value = 0
  const failed: string[] = []
  let lastError = ''
  for (const entry of props.entries) {
    try {
      await moveFile(entry.path, dir.value)
      movedCount.value++
    } catch (e) {
      failed.push(entry.name)
      lastError = e instanceof Error ? e.message : 'Moving failed'
    }
  }
  moving.value = false
  if (failed.length === 0) return emit('moved')
  error.value =
    props.entries.length === 1
      ? lastError
      : `${failed.length} not moved (${lastError}): ${failed.join(', ')}`
}

/** Closing after some files were moved still has the folder listed again */
function close() {
  if (moving.value) return
  if (movedCount.value > 0) emit('moved')
  else emit('close')
}

onMounted(() => open(fromDir))
</script>

<template>
  <!-- Escape, a tap outside and its ✕ all go through close() (not while moving) -->
  <ModalDialog title="Move" :subtitle="what" wide :locked="moving" @close="close">
        <!-- where the picker is -->
        <nav class="path">
          <button class="crumb" @click="open('')">⌂</button>
          <template v-for="crumb in crumbs" :key="crumb.path">
            <span class="sep">/</span>
            <button class="crumb" @click="open(crumb.path)">{{ crumb.name }}</button>
          </template>
        </nav>

        <ul class="list">
          <li v-if="dir !== ''">
            <button class="folder" @click="open(parentOf(dir))">↑ ..</button>
          </li>
          <li v-for="folder in folders" :key="folder.path">
            <button class="folder" @click="open(folder.path)">📁 {{ folder.name }}</button>
          </li>
          <li v-if="!loading && folders.length === 0" class="hint">No subfolders</li>
          <li v-if="loading" class="hint">Loading…</li>
        </ul>

        <p v-if="error" class="error">{{ error }}</p>

        <div class="actions">
          <button class="button" :disabled="moving" @click="close">Cancel</button>
          <button
            class="button primary"
            :disabled="moving || isSameFolder"
            :title="isSameFolder ? 'Already in this folder' : ''"
            @click="moveHere"
          >
            {{
              !moving
                ? 'Move here'
                : entries.length > 1
                  ? `Moving ${movedCount + 1} of ${entries.length}…`
                  : 'Moving…'
            }}
          </button>
        </div>
  </ModalDialog>
</template>

<style scoped>
.path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.15rem;
  font-size: 0.8rem;
}

.crumb {
  padding: 0.15rem 0.4rem;
  border: none;
  border-radius: 6px;
  background: none;
  color: #aaa;
  cursor: pointer;
}

.crumb:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.sep {
  color: #444;
}

/* see-through on the popup's glass, like the menus' date box (CardMenu.vue);
   scrolls by itself, so the popup keeps its path and buttons in view */
.list {
  flex: 1;
  min-height: 6rem;
  max-height: 45dvh;
  margin: 0;
  padding: 0.25rem;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--edge-soft);
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.025);
}

.folder {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: none;
  border-radius: 0.4rem;
  background: none;
  color: #ddd;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.hint {
  padding: 0.5rem 0.6rem;
  color: #666;
  font-size: 0.8rem;
}

.error {
  margin: 0;
  color: #e74c3c;
  font-size: 0.8rem;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.button {
  padding: 0.45rem 0.9rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
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
  opacity: 0.5;
  cursor: default;
}
</style>
