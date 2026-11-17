<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { discardUpload, uploadFile, UploadCancelled, type Upload } from '@/api'
import { UPLOAD_CONCURRENCY } from '@/constants'
import { formatSize } from '@/utils/format'

/**
 * Uploads files from the device into a folder, UPLOAD_CONCURRENCY at a time,
 * showing the progress of each and of the whole batch. Starts as soon as it opens.
 *
 * A file only appears in the folder once it has fully arrived: a cut-off or
 * stopped file is thrown away by the server (it's written to a hidden .part
 * file first). For the batch:
 * - Stop: the files that already arrived stay; the rest are dropped
 * - Cancel: everything is thrown away, including the files that already arrived
 */
const props = defineProps<{
  /** Folder to upload into */
  dir: string
  folderName: string
  files: File[]
}>()
/** `uploaded`: at least one file was saved, so the listing should be reloaded */
const emit = defineEmits<{ close: []; uploaded: [] }>()

type State = 'waiting' | 'uploading' | 'done' | 'failed' | 'cancelled' | 'discarded'

interface Item {
  file: File
  state: State
  sent: number
  /** Error message, or the name it was saved under if that differs */
  note: string
  /** Where it was saved (done only), so Cancel can discard it */
  path: string
}

const items = reactive<Item[]>(
  props.files.map((file): Item => ({ file, state: 'waiting', sent: 0, note: '', path: '' })),
)
/** Uploads in flight, so Stop / Cancel can stop them all */
const running = new Set<Upload>()
const finished = ref(false)
/** Cancel is throwing the batch away */
const discarding = ref(false)
/** Resolves once every upload has ended (finished, failed or stopped) */
let allEnded: Promise<void> = Promise.resolve()

const totalBytes = computed(() => items.reduce((sum, i) => sum + i.file.size, 0))
const sentBytes = computed(() =>
  items.reduce((sum, i) => sum + (i.state === 'done' ? i.file.size : i.sent), 0),
)
const percent = computed(() =>
  totalBytes.value ? Math.min(100, (sentBytes.value / totalBytes.value) * 100) : 0,
)
const doneCount = computed(() => items.filter((i) => i.state === 'done').length)
const failedCount = computed(() => items.filter((i) => i.state === 'failed').length)

const summary = computed(() => {
  if (!finished.value) {
    return `${formatSize(sentBytes.value)} of ${formatSize(totalBytes.value)}`
  }
  const discarded = items.filter((i) => i.state === 'discarded').length
  const parts = [`${doneCount.value} uploaded`]
  if (failedCount.value) parts.push(`${failedCount.value} failed`)
  if (discarded) parts.push(`${discarded} discarded`)
  const stopped = items.length - doneCount.value - failedCount.value - discarded
  if (stopped) parts.push(`${stopped} stopped`)
  return parts.join(' · ')
})

const title = computed(() => {
  if (discarding.value) return 'Discarding…'
  if (!finished.value) return 'Uploading…'
  return items.some((i) => i.state === 'discarded') ? 'Upload cancelled' : 'Upload finished'
})

/** Something in this batch could still be thrown away by Cancel */
const canCancel = computed(
  () => !discarding.value && (!finished.value || doneCount.value > 0),
)

// ── Speed ──
// Measured over the last few seconds (not since the start), so a slowdown
// shows right away: e.g. a fast start while the server's RAM soaks up the
// writes, then the real speed of its disk.
const SPEED_WINDOW_MS = 4000
const SPEED_SAMPLE_MS = 500
const samples: Array<{ at: number; bytes: number }> = []
/** Bytes per second right now; null until there's enough to tell */
const speed = ref<number | null>(null)

function sampleSpeed() {
  const now = performance.now()
  samples.push({ at: now, bytes: sentBytes.value })
  while (samples.length > 2 && now - samples[0]!.at > SPEED_WINDOW_MS) samples.shift()
  const first = samples[0]!
  const secs = (now - first.at) / 1000
  speed.value = secs >= 1 ? Math.max(0, (sentBytes.value - first.bytes) / secs) : null
}

let speedTimer: ReturnType<typeof setInterval> | undefined

/** "5.1 MB/s · 41 Mbit/s": the second to compare with internet speed tests */
const speedText = computed(() => {
  if (speed.value === null) return 'measuring speed…'
  const megabytes = speed.value / (1024 * 1024)
  const megabits = (speed.value * 8) / 1_000_000
  return `${megabytes.toFixed(1)} MB/s · ${megabits.toFixed(0)} Mbit/s`
})

/** Time left at the current speed */
const etaText = computed(() => {
  if (!speed.value) return ''
  const secs = (totalBytes.value - sentBytes.value) / speed.value
  if (secs < 60) return `${Math.ceil(secs)} s left`
  if (secs < 3600) return `${Math.round(secs / 60)} min left`
  return `${(secs / 3600).toFixed(1)} h left`
})

function itemPercent(item: Item): number {
  if (item.state === 'done') return 100
  return item.file.size ? Math.min(100, (item.sent / item.file.size) * 100) : 0
}

async function send(item: Item) {
  item.state = 'uploading'
  const upload = uploadFile(props.dir, item.file, (sent) => (item.sent = sent))
  running.add(upload)
  try {
    const saved = await upload.done
    item.state = 'done'
    item.path = saved.path
    if (saved.name !== item.file.name) item.note = `Saved as ${saved.name}`
  } catch (e) {
    if (e instanceof UploadCancelled) {
      item.state = 'cancelled'
    } else {
      item.state = 'failed'
      item.note = e instanceof Error ? e.message : 'Failed'
    }
  } finally {
    running.delete(upload)
  }
}

/** Each worker takes the next waiting file until none are left */
async function worker() {
  for (;;) {
    const next = items.find((i) => i.state === 'waiting') // skips ones cancelled before their turn
    if (!next) return
    await send(next)
  }
}

function start() {
  const count = Math.max(1, Math.min(UPLOAD_CONCURRENCY, items.length))
  speedTimer = setInterval(sampleSpeed, SPEED_SAMPLE_MS)
  allEnded = Promise.all(Array.from({ length: count }, worker)).then(() => {
    finished.value = true
    clearInterval(speedTimer)
  })
}

/**
 * Stop: stops the running uploads (the server drops their partial files) and
 * skips the ones still waiting. Files that already arrived are kept.
 */
function stopAll() {
  for (const item of items) if (item.state === 'waiting') item.state = 'cancelled'
  for (const upload of running) upload.cancel()
}

/**
 * Cancel: stops everything like Stop, then has the server delete every file
 * of this batch that already arrived, so nothing of it is kept
 */
async function cancelAll() {
  if (discarding.value) return
  discarding.value = true
  stopAll()
  // a file can still finish while being stopped: wait, so it's discarded too
  await allEnded
  for (const item of items) {
    if (item.state !== 'done' || !item.path) continue
    try {
      await discardUpload(item.path)
      item.state = 'discarded'
      item.note = ''
    } catch (e) {
      // it stays in the folder: say so
      item.note = `Not discarded: ${e instanceof Error ? e.message : 'failed'}`
    }
  }
  discarding.value = false
}

function close() {
  if (!finished.value || discarding.value) return
  // files arrived (and may still be there), or were removed again: list the folder anew
  if (items.some((i) => i.state === 'done' || i.state === 'discarded')) emit('uploaded')
  emit('close')
}

/** Leaving or reloading the page would cut the upload off: ask first */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!finished.value || discarding.value) e.preventDefault()
}

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  start()
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  clearInterval(speedTimer)
  // closing mid-way keeps what already arrived, like Stop
  stopAll()
})
</script>

<template>
  <ModalDialog
    :title="title"
    :subtitle="`Into ${folderName}`"
    :locked="!finished || discarding"
    @close="close"
  >
    <!-- Whole batch -->
    <div class="overall">
      <div class="bar" :class="{ finished, failed: finished && doneCount === 0 }">
        <div class="fill" :style="{ width: `${percent}%` }" />
      </div>
      <div class="overall-text">
        <span>{{ summary }}</span>
        <span v-if="!finished">{{ Math.floor(percent) }}%</span>
      </div>
      <!-- only while sending -->
      <div v-if="!finished && !discarding" class="overall-text speed">
        <span>{{ speedText }}</span>
        <span>{{ etaText }}</span>
      </div>
    </div>

    <!-- Each file -->
    <ul class="files">
      <li v-for="(item, i) in items" :key="i" class="file" :class="item.state">
        <div class="file-row">
          <span class="file-state" :title="item.state">
            <template v-if="item.state === 'done'">✓</template>
            <template v-else-if="item.state === 'failed'">!</template>
            <template v-else-if="item.state === 'cancelled'">–</template>
            <template v-else-if="item.state === 'discarded'">✕</template>
            <span v-else-if="item.state === 'uploading'" class="spinner" />
            <template v-else>•</template>
          </span>
          <span class="file-name" :title="item.file.name">{{ item.file.name }}</span>
          <span class="file-size">
            {{
              item.state === 'uploading'
                ? `${Math.floor(itemPercent(item))}%`
                : formatSize(item.file.size)
            }}
          </span>
        </div>
        <div v-if="item.state === 'uploading'" class="bar small">
          <div class="fill" :style="{ width: `${itemPercent(item)}%` }" />
        </div>
        <p v-if="item.note" class="file-note">{{ item.note }}</p>
      </li>
    </ul>

    <!-- Cancel on its own at the left (throws everything away); Stop and Done
         together at the right (keep what arrived) -->
    <div class="actions">
      <button
        class="button danger"
        :disabled="!canCancel"
        title="Stop and delete every file of this upload, including the ones that already arrived"
        @click="cancelAll"
      >
        {{ discarding ? 'Discarding…' : 'Cancel' }}
      </button>
      <span class="spacer" />
      <button
        class="button"
        :disabled="finished || discarding"
        title="Stop the rest; the files that already arrived stay"
        @click="stopAll"
      >
        Stop
      </button>
      <button class="button primary" :disabled="!finished || discarding" @click="close">
        Done
      </button>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* ── Progress bars ── */
.bar {
  height: 0.5rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.bar.small {
  height: 0.25rem;
  margin-top: 0.4rem;
}

.fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #2d6cdf, #8a5cf6);
  transition: width 0.2s linear;
}

.bar.finished .fill {
  background: #3fae62;
}

.bar.failed .fill {
  background: #c0392b;
}

.overall {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.overall-text {
  display: flex;
  justify-content: space-between;
  color: #aaa;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.overall-text.speed {
  color: #8f88aa;
}

/* ── File list ── */
.files {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 45dvh;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.file {
  padding: 0.55rem 0.7rem;
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.04);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.file-state {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.2rem;
  color: #666;
  font-weight: 700;
}

.file.done .file-state {
  color: #6fdc8c;
}

.file.failed .file-state,
.file.failed .file-note {
  color: #f07060;
}

.file.cancelled,
.file.discarded {
  opacity: 0.5;
}

.file.discarded .file-name {
  text-decoration: line-through;
}

.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ddd;
}

.file-size {
  flex: none;
  color: #888;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}

.file-note {
  margin: 0.25rem 0 0 1.8rem;
  color: #999;
  font-size: 0.72rem;
}

.spinner {
  width: 0.8rem;
  height: 0.8rem;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: #8a5cf6;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Buttons ── */
.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* splits Cancel (left) from Stop and Done (right) */
.spacer {
  flex: 1;
}

.button {
  padding: 0.55rem 1.1rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
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

/* throws files away: red text, like the trash action in the file menu */
.button.danger {
  color: #f07060;
  border-color: rgba(231, 76, 60, 0.35);
}

.button.danger:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  color: #ff8a7a;
}
</style>
