<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import CardMenu from '@/components/CardMenu.vue'
import CompressDialog from '@/components/CompressDialog.vue'
import EditDialog from '@/components/EditDialog.vue'
import MovePicker from '@/components/MovePicker.vue'
import RenameDialog from '@/components/RenameDialog.vue'
import { fixTs, trashFile } from '@/api'
import { recordsVideoData } from '@/appMode'
import { RELOAD_GALLERY_KEY } from '@/composables/useGallery'
import {
  COMPRESS_LABEL,
  EDIT_LABEL,
  FIX_TS_LABEL,
  MOVE_LABEL,
  RENAME_LABEL,
  TRASH_CONFIRM,
  TRASH_LABEL,
} from '@/constants'
import {
  ICON_COMPRESS,
  ICON_CROP,
  ICON_FIX,
  ICON_FOLDER_MOVE,
  ICON_RENAME,
  ICON_TRASH,
} from '@/icons'
import type { Entry, MenuItem } from '@/types'
import { isCompressible, isEditable } from '@/utils/entry'
import { minuteClock } from '@/utils/clock'
import { formatDate, formatDateAgo, formatSize } from '@/utils/format'

/**
 * Menu of a video / image / file card: fix, compress, rename, move or delete
 * it. The card opens it (`open()`) on a right-click or press-and-hold.
 */
const props = defineProps<{ entry: Entry }>()
/** The file is gone from this folder or changed size: the listing should be reloaded */
const emit = defineEmits<{ changed: [] }>()

const menu = ref<InstanceType<typeof CardMenu> | null>(null)
defineExpose({ open: () => menu.value?.open() })

const picking = ref(false)
const compressing = ref(false)
const editing = ref(false)
const renaming = ref(false)
/** How far along Fix TS is (0–100); null until the server says */
const fixPercent = ref<number | null>(null)
/** Fix TS is done on the server; waiting for the copy to show in the grid */
const fixListing = ref(false)

/** Re-lists the folder and resolves once the grid shows it (App); without it, just ask for a reload */
const reloadGallery =
  inject(RELOAD_GALLERY_KEY, null) ??
  (async () => {
    emit('changed')
  })

function fixBusyLabel(): string {
  if (fixListing.value) return 'Adding to the grid…'
  return fixPercent.value === null ? 'Fixing…' : `Fixing… ${fixPercent.value}%`
}

const items: MenuItem[] = [
  ...(props.entry.needs_fix
    ? [
        {
          label: FIX_TS_LABEL,
          description: 'Save a playable MP4 copy next to it (lossless)',
          icon: ICON_FIX,
          busyLabel: fixBusyLabel,
          // the spinner (CardMenu) runs until the copy is in the grid, then the menu closes
          async run() {
            fixPercent.value = null
            fixListing.value = false
            try {
              await fixTs(props.entry.path, (f) => (fixPercent.value = Math.floor(f * 100)))
              fixListing.value = true
              await reloadGallery()
            } finally {
              fixListing.value = false
            }
            return null
          },
        },
      ]
    : []),
  ...(isCompressible(props.entry)
    ? [
        {
          label: COMPRESS_LABEL,
          description: 'Save a smaller copy next to it, looking the same',
          icon: ICON_COMPRESS,
          async run() {
            compressing.value = true
            return null
          },
        },
      ]
    : []),
  ...(isEditable(props.entry)
    ? [
        {
          label: EDIT_LABEL,
          description:
            props.entry.kind === 'video'
              ? 'Rename, set its views, trim the ends or crop the edges'
              : 'Rename, set its views or crop the edges',
          icon: ICON_CROP,
          async run() {
            editing.value = true
            return null
          },
        },
      ]
    : []),
  // videos and photos are renamed in the edit popup (with their views); other files here
  ...(isEditable(props.entry)
    ? []
    : [
        {
          label: RENAME_LABEL,
          description: 'Give it a new name',
          icon: ICON_RENAME,
          async run() {
            renaming.value = true
            return null
          },
        },
      ]),
  {
    label: MOVE_LABEL,
    description: 'Put it in another folder',
    icon: ICON_FOLDER_MOVE,
    async run() {
      picking.value = true
      return null
    },
  },
  {
    label: TRASH_LABEL,
    description: 'Restorable from your file manager',
    icon: ICON_TRASH,
    busyLabel: 'Moving to trash…',
    danger: true,
    confirm: { message: TRASH_CONFIRM.replace('{name}', props.entry.name) },
    async run() {
      await trashFile(props.entry.path)
      emit('changed')
      return null
    },
  },
]

/** Its dates, at the top of the menu (they're no longer on the card) */
const details = computed(() => {
  const list: Array<{ label: string; value: string }> = []
  if (props.entry.added) list.push({ label: 'Added', value: formatDate(props.entry.added) })
  // photos and videos are "viewed": shown / played in the viewer
  // dev mode: not shown (src/appMode.ts)
  if ((props.entry.kind === 'video' || props.entry.kind === 'image') && recordsVideoData.value) {
    list.push({
      label: 'Last viewed',
      value: props.entry.last_viewed
        ? formatDateAgo(props.entry.last_viewed, minuteClock.value)
        : 'Never',
    })
    // how often, on every device (what the "Most played" sections go by)
    const plays = props.entry.plays ?? 0
    list.push({ label: 'Views', value: String(plays) })
  }
  return list
})

function onMoved() {
  picking.value = false
  emit('changed')
}
</script>

<template>
  <CardMenu
    ref="menu"
    :items="items"
    :title="entry.name"
    :subtitle="entry.size ? formatSize(entry.size) : undefined"
    :details="details"
  />
  <RenameDialog
    v-if="renaming"
    :path="entry.path"
    :name="entry.name"
    @renamed="emit('changed')"
    @close="renaming = false"
  />
  <MovePicker v-if="picking" :entries="[entry]" @close="picking = false" @moved="onMoved" />
  <CompressDialog
    v-if="compressing"
    :entries="[entry]"
    @changed="emit('changed')"
    @close="compressing = false"
  />
  <EditDialog
    v-if="editing"
    :entry="entry"
    @changed="emit('changed')"
    @close="editing = false"
  />
</template>
