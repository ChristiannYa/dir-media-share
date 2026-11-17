<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import CardMenu from '@/components/CardMenu.vue'
import NewFolderDialog from '@/components/NewFolderDialog.vue'
import RenameDialog from '@/components/RenameDialog.vue'
import UploadDialog from '@/components/UploadDialog.vue'
import { bumpCacheVersion, clearCache, numberFiles } from '@/api'
import { recordsVideoData } from '@/appMode'
import { REVEAL_ENTRY_KEY } from '@/composables/useGallery'
import {
  CLEAR_CACHE_CONFIRM,
  CLEAR_CACHE_LABEL,
  NEW_FOLDER_LABEL,
  NUMBER_FILES_CONFIRM,
  NUMBER_FILES_LABEL,
  RENAME_LABEL,
  UPLOAD_ACCEPT,
  UPLOAD_LABEL,
} from '@/constants'
import {
  ICON_CLEAR_CACHE,
  ICON_NEW_FOLDER,
  ICON_NUMBERED,
  ICON_RENAME,
  ICON_UPLOAD,
} from '@/icons'
import type { MenuItem } from '@/types'
import { minuteClock } from '@/utils/clock'
import { formatDate, formatDateAgo } from '@/utils/format'

/**
 * Menu of a folder: upload into it, make a subfolder, rename it, or clear its
 * cache. Opened (`open()`) by a right-click or press-and-hold on a folder card,
 * or on the open folder's name in the top bar. Its owners key it by path, so
 * `name` and `path` never change while it's mounted.
 */
const props = defineProps<{
  path: string
  name: string
  /**
   * Its dates, shown at the top of the menu (folder cards pass them; the top
   * bar's menu has none): when the newest video / image inside was added, and
   * when a video inside was last played
   */
  lastAdded?: number | null
  lastViewed?: number | null
  /** Show the dates at all (false on the top bar, which doesn't know them) */
  withDates?: boolean
}>()

const details = computed(() =>
  props.withDates
    ? [
        { label: 'Last added', value: props.lastAdded ? formatDate(props.lastAdded) : '—' },
        // dev mode: not shown (src/appMode.ts)
        ...(recordsVideoData.value
          ? [
              {
                label: 'Last viewed',
                value: props.lastViewed
                  ? formatDateAgo(props.lastViewed, minuteClock.value)
                  : 'Never',
              },
            ]
          : []),
      ]
    : undefined,
)
/** Files or a folder were added: the listing should be reloaded (counts, size, preview) */
const emit = defineEmits<{
  changed: []
  /** The folder was renamed: `path` is where it is now */
  renamed: [path: string]
}>()

const menu = ref<InstanceType<typeof CardMenu> | null>(null)
defineExpose({ open: () => menu.value?.open() })

const picker = ref<HTMLInputElement | null>(null)
/** Files picked on the device; the upload popup is open while set */
const uploading = ref<File[] | null>(null)
/** The "New folder" name popup is open */
const naming = ref(false)
/** The "Rename" popup is open */
const renaming = ref(false)

const items: MenuItem[] = [
  {
    label: UPLOAD_LABEL,
    description: 'From this device, into this folder',
    icon: ICON_UPLOAD,
    async run() {
      // must happen during the tap, or the browser blocks the file picker
      picker.value?.click()
      return null
    },
  },
  {
    label: NEW_FOLDER_LABEL,
    description: 'Create an empty folder inside this one',
    icon: ICON_NEW_FOLDER,
    async run() {
      naming.value = true
      return null
    },
  },
  {
    label: RENAME_LABEL,
    description: 'Give this folder a new name',
    icon: ICON_RENAME,
    async run() {
      renaming.value = true
      return null
    },
  },
  {
    label: NUMBER_FILES_LABEL,
    description: 'Rename its photos and videos 1, 2, 3… from the oldest',
    icon: ICON_NUMBERED,
    busyLabel: 'Renaming…',
    confirm: { message: NUMBER_FILES_CONFIRM.replace('{name}', props.name), confirmLabel: 'Rename' },
    async run() {
      const renamed = await numberFiles(props.path)
      emit('changed')
      if (renamed === 0) return 'Already numbered'
      return renamed === 1 ? 'Renamed 1 file' : `Renamed ${renamed} files`
    },
  },
  {
    label: CLEAR_CACHE_LABEL,
    description: 'Rebuild stills, previews and storyboards',
    icon: ICON_CLEAR_CACHE,
    busyLabel: 'Clearing…',
    confirm: { message: CLEAR_CACHE_CONFIRM.replace('{name}', props.name) },
    async run() {
      const removed = await clearCache(props.path)
      bumpCacheVersion()
      return removed === 1 ? 'Removed 1 file' : `Removed ${removed} files`
    },
  },
]

function onPicked() {
  const input = picker.value
  if (!input?.files?.length) return
  uploading.value = [...input.files]
  input.value = '' // so picking the same files again still fires `change`
}

function onUploadClosed() {
  uploading.value = null
}

/** Re-lists the folder and scrolls to the new folder (App); without it, just ask for a reload */
const revealEntry = inject(REVEAL_ENTRY_KEY, null)

function onFolderCreated(path: string) {
  if (revealEntry) void revealEntry(path)
  else emit('changed')
}
</script>

<template>
  <CardMenu ref="menu" :items="items" :title="name" subtitle="Folder" :details="details" />

  <!-- hidden; opened by the menu item. In <body>, so its click can't open the card -->
  <Teleport to="body">
    <input
      ref="picker"
      class="picker"
      type="file"
      multiple
      :accept="UPLOAD_ACCEPT"
      tabindex="-1"
      aria-hidden="true"
      @change="onPicked"
    />
  </Teleport>

  <UploadDialog
    v-if="uploading"
    :dir="path"
    :folder-name="name"
    :files="uploading"
    @uploaded="emit('changed')"
    @close="onUploadClosed"
  />

  <NewFolderDialog
    v-if="naming"
    :dir="path"
    :folder-name="name"
    @created="onFolderCreated"
    @close="naming = false"
  />

  <RenameDialog
    v-if="renaming"
    :path="path"
    :name="name"
    folder
    @renamed="emit('renamed', $event)"
    @close="renaming = false"
  />
</template>

<style scoped>
/* not display:none: some mobile browsers won't open the picker of a hidden input */
.picker {
  position: fixed;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  left: -100px;
}
</style>
