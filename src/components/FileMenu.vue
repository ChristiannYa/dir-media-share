<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import CardMenu from '@/components/CardMenu.vue'
import EditDialog from '@/components/EditDialog.vue'
import MovePicker from '@/components/MovePicker.vue'
import RenameDialog from '@/components/RenameDialog.vue'
import { fileUrl, fixTs, queueCompress, trashFile } from '@/api'
import { pulseCompress, useCompressQueue } from '@/composables/useCompressQueue'
import { popupsGone } from '@/composables/usePopupOpen'
import { RELOAD_GALLERY_KEY, SELECTION_KEY } from '@/composables/useGallery'
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
  ICON_DOWNLOAD,
  ICON_EDIT,
  ICON_FIX,
  ICON_FOLDER_MOVE,
  ICON_RENAME,
  ICON_SELECT,
  ICON_TRASH,
} from '@/icons'
import type { Entry, MenuDetail, MenuItem } from '@/types'
import { downloadFile } from '@/utils/download'
import { puffAway } from '@/utils/puff'
import { isCompressible, isEditable } from '@/utils/entry'
import { minuteClock } from '@/utils/clock'
import { formatAgo, formatLongDate, formatSize } from '@/utils/format'

/**
 * Menu of a video / image / file card: its dates, then icon buttons to fix,
 * edit (or rename), download (photos and videos), compress, select (turns on
 * selection mode), move or delete it (the rows are listed above the items,
 * below). The card opens it
 * (`open()`) on a right-click or press-and-hold.
 */
const props = defineProps<{ entry: Entry }>()
/** The file is gone from this folder or changed size: the listing should be reloaded */
const emit = defineEmits<{ changed: [] }>()

const menu = ref<InstanceType<typeof CardMenu> | null>(null)
defineExpose({ open: () => menu.value?.open() })

const picking = ref(false)
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

// The menu's buttons are icons only (CardMenu's icon-only): each label is
// its tooltip and screen-reader name. In rows:
//  1. Fix TS (only for a .ts that needs it)
//  2. edit (rename for files that can't be edited), download, compress, select
//  3. move, trash

const fixItem: MenuItem = {
  label: FIX_TS_LABEL,
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
}

/** Videos and photos are renamed in the edit popup (with their views); other files get rename instead */
const editItem: MenuItem = isEditable(props.entry)
  ? {
      label: EDIT_LABEL,
      icon: ICON_EDIT,
      row: 'tools',
      async run() {
        editing.value = true
        return null
      },
    }
  : {
      label: RENAME_LABEL,
      icon: ICON_RENAME,
      row: 'tools',
      async run() {
        renaming.value = true
        return null
      },
    }

/** Saves the file to the device, under its own name */
const downloadItem: MenuItem = {
  label: 'Download',
  icon: ICON_DOWNLOAD,
  row: 'tools',
  async run() {
    downloadFile(fileUrl(props.entry.path), props.entry.name)
    return null
  },
}

const { activePaths } = useCompressQueue()
/** This file is waiting or compressing right now */
const compressQueued = computed(() => activePaths.value.has(props.entry.path))

/**
 * Adds it to the server's compress queue, which works in the background: its
 * progress is in the top bar's compress button (CompressButton.vue). The menu
 * closes at once, without waiting for the server's answer: the top bar's
 * button shows it was queued, and only a problem (already in the queue, not
 * compressible, no connection) is said, in an alert
 */
const compressItem = computed<MenuItem>(() => ({
  label: COMPRESS_LABEL,
  icon: ICON_COMPRESS,
  row: 'tools',
  // already waiting or compressing (started from this or another device)
  disabled: compressQueued.value,
  disabledReason: 'Already in the compress queue',
  async run() {
    pulseCompress()
    queueCompress([props.entry]).then(
      ({ refused }) => {
        if (refused[0]) alert(`${props.entry.name}: ${refused[0].error}`)
      },
      (e: unknown) => alert(e instanceof Error ? e.message : 'Compressing failed'),
    )
    return null
  },
}))

/**
 * Selection mode (App.vue): closes the menu and turns it on with this file
 * already picked, to pick more and move or delete them together. Not shown
 * while it's already on
 */
const selection = inject(SELECTION_KEY, null)
const selectItem: MenuItem = {
  label: 'Select',
  icon: ICON_SELECT,
  row: 'tools',
  async run() {
    selection?.start(props.entry.path)
    return null
  },
}

const moveItem: MenuItem = {
  label: MOVE_LABEL,
  icon: ICON_FOLDER_MOVE,
  row: 'move-trash',
  async run() {
    picking.value = true
    return null
  },
}

const trashItem: MenuItem = {
  label: TRASH_LABEL,
  icon: ICON_TRASH,
  busyLabel: 'Moving to trash…',
  danger: true,
  row: 'move-trash',
  confirm: { message: TRASH_CONFIRM.replace('{name}', props.entry.name) },
  async run() {
    const path = props.entry.path
    await trashFile(path)
    // the menu closes first (null), then the card goes up in a puff where it
    // was (utils/puff.ts), and only then the folder lists again without it
    void popupsGone()
      .then(() => puffAway([path]))
      .finally(() => emit('changed'))
    return null
  },
}

const menuItems = computed<MenuItem[]>(() => [
  ...(props.entry.needs_fix ? [fixItem] : []),
  editItem,
  ...(props.entry.kind === 'image' || props.entry.kind === 'video' ? [downloadItem] : []),
  ...(isCompressible(props.entry) ? [compressItem.value] : []),
  ...(selection && !selection.active.value ? [selectItem] : []),
  moveItem,
  trashItem,
])

/** Its dates, at the top of the menu (they're no longer on the card) */
const details = computed(() => {
  const list: MenuDetail[] = []
  if (props.entry.added) list.push({ label: 'Added', value: formatLongDate(props.entry.added) })
  // photos and videos are "viewed": shown / played in the viewer
  if (props.entry.kind === 'video' || props.entry.kind === 'image') {
    const last = props.entry.last_viewed
    list.push({
      label: 'Last viewed',
      value: last ? formatLongDate(last) : 'Never',
      // how long ago, on its own line under the date
      note: last ? formatAgo(last, minuteClock.value) : undefined,
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
    :items="menuItems"
    icon-only
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
  <EditDialog
    v-if="editing"
    :entry="entry"
    @changed="emit('changed')"
    @close="editing = false"
  />
</template>
