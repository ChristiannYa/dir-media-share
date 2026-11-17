<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchFolders, moveFile } from '@/api'
import { usePauseBackgroundWhileMounted } from '@/composables/useBackgroundPause'
import type { Entry, FolderRef } from '@/types'

/**
 * Dialog to pick a folder (anywhere in the shared folder) and move one or
 * more files there (all from the same folder). Starts in their own folder.
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

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

onMounted(() => {
  open(fromDir)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// its backdrop blurs the whole screen: no need to keep the sky moving behind it
usePauseBackgroundWhileMounted()
</script>

<template>
  <!-- rendered at the end of <body>, so it isn't clipped by the card or opens it on click -->
  <Teleport to="body">
    <div class="backdrop" @click.self="close">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2 class="title">
          Move <span class="name">{{ what }}</span>
        </h2>

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
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  /* same look as ModalDialog */
  background: rgba(6, 5, 10, 0.55);
  backdrop-filter: blur(12px) saturate(120%);
  -webkit-backdrop-filter: blur(12px) saturate(120%);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: min(28rem, 100%);
  max-height: 80vh;
  padding: 1rem;
  border: 1px solid var(--edge);
  border-radius: 1rem;
  background: #161616;
  color: #e8e8e8;
  box-shadow:
    var(--edge-shine),
    0 12px 40px rgba(0, 0, 0, 0.6);
}

.title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  color: #aaa;
  font-weight: 400;
}

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
  background: #222;
  color: #fff;
}

.sep {
  color: #444;
}

.list {
  flex: 1;
  min-height: 6rem;
  margin: 0;
  padding: 0.25rem;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--edge-soft);
  border-radius: 0.6rem;
  background: #0f0f0f;
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
  background: #222;
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
