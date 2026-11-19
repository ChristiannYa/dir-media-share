<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import {
  deleteTrashItem,
  fetchTrash,
  restoreTrashItem,
  trashItemUrl,
  trashThumbUrl,
  type TrashItem,
} from '@/api'
import { revealInGallery } from '@/composables/useGallery'
import { formatAgo, formatSize } from '@/utils/format'
import { haptic } from '@/utils/haptics'

/**
 * The trash (opened from the top bar's trash button): what was deleted from
 * the shared folder, the last first, from the desktop's trash
 * (server/trash.ts). Per item: Restore puts it back in the folder it was
 * deleted from (as "name (2)" if that name is taken now), Delete removes it
 * for good, after asking. A tap on a photo or video shows it here first.
 * Items deleted on the computer from elsewhere aren't listed.
 */
const emit = defineEmits<{
  close: []
  /** Something was restored into the shared folder: the open folder may need listing again */
  changed: []
}>()

const items = ref<TrashItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

/** Restored items → where they are now, for their "Show" button */
const restored = ref(new Map<string, string>())
/** Requests on their way, by item id, so its buttons wait */
const busy = ref(new Set<string>())
/** The photo / video shown open under its row (one at a time) */
const openId = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    items.value = await fetchTrash()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Loading the trash failed'
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** Still in the trash (restored ones stay listed, with where they went) */
const remaining = computed(() => items.value.filter((i) => !restored.value.has(i.id)))

const subtitle = computed(() => {
  if (loading.value) return 'Loading…'
  const n = remaining.value.length
  if (n === 0) return 'Empty'
  const size = remaining.value.reduce((sum, i) => sum + i.size, 0)
  return `${n} ${n === 1 ? 'item' : 'items'} · ${formatSize(size)}`
})

async function act(id: string, action: () => Promise<void>) {
  if (busy.value.has(id)) return
  busy.value.add(id)
  error.value = null
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'It failed'
  } finally {
    busy.value.delete(id)
  }
}

function restore(item: TrashItem) {
  haptic('tap')
  void act(item.id, async () => {
    const path = await restoreTrashItem(item.id)
    restored.value.set(item.id, path)
    if (openId.value === item.id) openId.value = null
    emit('changed')
  })
}

function remove(item: TrashItem) {
  if (!confirm(`Delete "${item.name}" for good? It can't be restored after this.`)) return
  void act(item.id, async () => {
    await deleteTrashItem(item.id)
    items.value = items.value.filter((i) => i.id !== item.id)
    if (openId.value === item.id) openId.value = null
  })
}

/** A restored item: closes the trash and goes to its card (its folder opens first) */
function show(item: TrashItem) {
  const path = restored.value.get(item.id)
  if (!path) return
  haptic('tap')
  emit('close')
  void revealInGallery(path)
}

/** A tap on a photo / video row shows it under the row (again: hides it) */
function toggleOpen(item: TrashItem) {
  if (restored.value.has(item.id)) return
  if (item.kind !== 'image' && item.kind !== 'video') return
  openId.value = openId.value === item.id ? null : item.id
}

/** Items whose still couldn't be made (unreadable, ffmpeg missing): an icon instead */
const thumbFailed = ref(new Set<string>())

/** A photo / video still in the trash, whose still could be made */
function hasStill(item: TrashItem): boolean {
  return (
    (item.kind === 'image' || item.kind === 'video') &&
    !restored.value.has(item.id) &&
    !thumbFailed.value.has(item.id)
  )
}

function folderLabel(folder: string): string {
  return folder ? folder.split('/').join(' / ') : 'Shared folder'
}

function icon(item: TrashItem): string {
  if (item.kind === 'folder') return '📁'
  if (item.kind === 'video') return '🎬'
  if (item.kind === 'image') return '🖼'
  return '📄'
}
</script>

<template>
  <ModalDialog title="Trash" :subtitle="subtitle" wide @close="emit('close')">
    <p v-if="!loading && items.length === 0 && !error" class="empty">
      Nothing deleted from the shared folder is in the trash.
    </p>

    <ul v-else-if="items.length > 0" class="items">
      <li
        v-for="item in items"
        :key="item.id"
        class="item"
        :class="{ restored: restored.has(item.id), open: openId === item.id }"
      >
        <div class="row">
          <!-- photos and videos: their still, made by the server (a video's
               from its middle, with a play mark); the rest, an icon. A tap
               shows the photo / plays the video under the row -->
          <button
            type="button"
            class="thumb"
            :class="{ media: hasStill(item) }"
            :disabled="!hasStill(item)"
            :title="hasStill(item) ? (item.kind === 'video' ? 'Play it' : 'Show it') : undefined"
            @click="toggleOpen(item)"
          >
            <template v-if="hasStill(item)">
              <img
                :src="trashThumbUrl(item)"
                alt=""
                loading="lazy"
                draggable="false"
                @error="thumbFailed.add(item.id)"
              />
              <span v-if="item.kind === 'video'" class="play" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </template>
            <span v-else aria-hidden="true">{{ icon(item) }}</span>
          </button>
          <div class="text">
            <span class="name" :title="item.path">{{ item.name }}</span>
            <span class="meta">
              <template v-if="restored.has(item.id)">Restored to {{ restored.get(item.id) }}</template>
              <template v-else>
                {{ folderLabel(item.folder) }}
                <template v-if="item.deletedAt"> · deleted {{ formatAgo(item.deletedAt) }}</template>
                <template v-if="item.size"> · {{ formatSize(item.size) }}</template>
              </template>
            </span>
          </div>
          <div class="buttons">
            <button
              v-if="restored.has(item.id)"
              type="button"
              class="button"
              title="Go to it in the gallery"
              @click="show(item)"
            >
              Show
            </button>
            <template v-else>
              <button
                type="button"
                class="button"
                :disabled="busy.has(item.id)"
                :title="`Put it back in ${folderLabel(item.folder)}`"
                @click="restore(item)"
              >
                Restore
              </button>
              <button
                type="button"
                class="button danger"
                :disabled="busy.has(item.id)"
                title="Delete it for good"
                @click="remove(item)"
              >
                Delete
              </button>
            </template>
          </div>
        </div>
        <!-- the photo / video itself, before deciding -->
        <div v-if="openId === item.id" class="viewer">
          <video
            v-if="item.kind === 'video'"
            :src="trashItemUrl(item.id)"
            controls
            playsinline
            preload="metadata"
          />
          <img v-else :src="trashItemUrl(item.id)" alt="" draggable="false" />
        </div>
      </li>
    </ul>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="items.length > 0" class="hint">
      Only what was deleted from the shared folder is listed. Restored files come back without their
      hearts and views (those are cleared when a file is deleted in the app).
    </p>

    <div class="actions">
      <button type="button" class="button" :disabled="loading" @click="load">Refresh</button>
      <span class="spacer" />
      <button type="button" class="button primary" @click="emit('close')">Close</button>
    </div>
  </ModalDialog>
</template>

<style scoped>
.empty,
.hint {
  margin: 0;
  color: #8f88aa;
  font-size: 0.8rem;
}

.hint {
  font-size: 0.72rem;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.8rem;
}

/* ── The list (as in CompressDialog) ── */
.items {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 60dvh;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.item {
  padding: 0.45rem 0.55rem;
  border-radius: 0.55rem;
  background: rgba(255, 255, 255, 0.04);
}

.item.restored {
  opacity: 0.7;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.thumb {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  /* a little wide, like the gallery's cards, so a video's still shows something */
  width: 4.2rem;
  height: 3rem;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--edge);
  border-radius: 0.45rem;
  background: rgba(0, 0, 0, 0.35);
  font-size: 1.2rem;
  cursor: default;
}

.thumb.media {
  cursor: pointer;
}

.thumb.media:hover {
  border-color: #8a5cf6;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* a video's: a play mark in a dark circle over the still */
.play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.play svg {
  width: 1.3rem;
  height: 1.3rem;
  padding: 0.2rem;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  fill: #fff;
}

.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.name {
  overflow: hidden;
  color: #ddd;
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  overflow: hidden;
  color: #888;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.buttons {
  flex: none;
  display: flex;
  gap: 0.35rem;
}

.viewer {
  display: flex;
  justify-content: center;
  margin-top: 0.5rem;
}

.viewer video,
.viewer img {
  display: block;
  max-width: 100%;
  max-height: 45dvh;
  border-radius: 0.45rem;
  background: #000;
}

/* ── Buttons (as in CompressDialog) ── */
.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spacer {
  flex: 1;
}

.button {
  padding: 0.45rem 0.8rem;
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

.button.primary {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.button.primary:hover:not(:disabled) {
  background: #3b7bf0;
}

.button.danger {
  color: #f07060;
  border-color: rgba(231, 76, 60, 0.35);
}

.button.danger:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  color: #ff8a7a;
}
</style>
