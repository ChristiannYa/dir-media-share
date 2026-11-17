<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { compressVideo, CompressCancelled, discardCompressed, type Compression } from '@/api'
import type { Entry } from '@/types'
import { formatSize } from '@/utils/format'

/**
 * Saves compressed copies of videos and photos on the server, one after
 * another (each video encode already uses every CPU core), showing the
 * progress of each and the size before and after. Starts as soon as it opens.
 *
 * Videos keep their resolution, frame timing and audio; photos their format
 * and size in pixels, each made as small as it gets without a visible change
 * (server/media/compressImage.ts). Each copy is saved next to its original,
 * named after the settings used ("clip [x264 crf20 slow].mp4", "photo [jpeg
 * q82].jpg"); the originals are never touched. A copy is only saved if it's
 * clearly smaller. For the batch:
 * - Stop: the copies already saved stay; the rest aren't made
 * - Cancel: also deletes the copies already saved
 */
const props = defineProps<{
  /** Videos and photos to compress (isCompressible) */
  entries: Entry[]
}>()
/** `changed`: copies were saved (or deleted again), so the listing should be reloaded */
const emit = defineEmits<{ close: []; changed: [] }>()

type State =
  | 'waiting'
  | 'compressing'
  | 'done'
  /** No copy saved (it would hardly shrink, HDR…): `note` says why */
  | 'skipped'
  | 'failed'
  | 'cancelled'
  /** A copy was saved, then deleted again by Cancel */
  | 'discarded'

interface Item {
  entry: Entry
  state: State
  /** Waiting for another compression on the server */
  queued: boolean
  /** 0–1 encoded */
  fraction: number
  /** × real time; null until known */
  speed: number | null
  before: number
  /** Size of the copy; null until it's done */
  after: number | null
  /** Where the copy was saved (done only), so Cancel can delete it */
  copyPath: string
  note: string
}

const items = reactive<Item[]>(
  props.entries.map(
    (entry): Item => ({
      entry,
      state: 'waiting',
      queued: false,
      fraction: 0,
      speed: null,
      before: entry.size ?? 0,
      after: null,
      copyPath: '',
      note: '',
    }),
  ),
)
/** Compressions in flight, so Stop / Cancel can stop them */
const running = new Set<Compression>()
const finished = ref(false)
/** Cancel is deleting the copies */
const discarding = ref(false)
/** Resolves once every compression has ended (finished, failed or stopped) */
let allEnded: Promise<void> = Promise.resolve()

/**
 * Seconds of video, which is what encoding time goes by (unknown: counted as
 * a minute). A photo takes about as long as a second of video
 */
function weight(item: Item): number {
  if (item.entry.kind === 'image') return 1
  return item.entry.duration || 60
}

/** What the batch is called: "videos", "photos", or "files" if it has both */
const noun = computed(() => {
  const images = items.filter((i) => i.entry.kind === 'image').length
  if (images === 0) return 'videos'
  return images === items.length ? 'photos' : 'files'
})

const totalWeight = computed(() => items.reduce((sum, i) => sum + weight(i), 0))
/** Seconds of video not encoded yet */
const remainingWeight = computed(() =>
  items.reduce((sum, i) => {
    if (i.state === 'waiting') return sum + weight(i)
    if (i.state === 'compressing') return sum + weight(i) * (1 - i.fraction)
    return sum
  }, 0),
)
const percent = computed(() =>
  totalWeight.value
    ? Math.min(100, ((totalWeight.value - remainingWeight.value) / totalWeight.value) * 100)
    : 0,
)

const countOf = (state: State) => items.filter((i) => i.state === state).length
const doneCount = computed(() => countOf('done'))

/**
 * Size of the whole batch before, and of its compressed versions (videos
 * without a copy count as they are)
 */
const totalBefore = computed(() => items.reduce((sum, i) => sum + i.before, 0))
const totalAfter = computed(() => items.reduce((sum, i) => sum + (i.after ?? i.before), 0))
const saved = computed(() => totalBefore.value - totalAfter.value)
const savedPercent = computed(() =>
  totalBefore.value ? Math.round((saved.value / totalBefore.value) * 100) : 0,
)

const summary = computed(() => {
  if (!finished.value) {
    const ended = items.filter((i) => i.state !== 'waiting' && i.state !== 'compressing').length
    return `${ended} of ${items.length} ${noun.value}`
  }
  const parts = [`${doneCount.value} compressed`]
  for (const [state, label] of [
    ['skipped', 'no copy made'],
    ['failed', 'failed'],
    ['discarded', 'discarded'],
    ['cancelled', 'stopped'],
  ] as const) {
    const n = countOf(state)
    if (n) parts.push(`${n} ${label}`)
  }
  return parts.join(' · ')
})

const title = computed(() => {
  if (discarding.value) return 'Discarding…'
  if (!finished.value) return 'Compressing…'
  return items.some((i) => i.state === 'discarded') ? 'Compression cancelled' : 'Compression finished'
})

const subtitle = computed(() =>
  items.length === 1 ? items[0]!.entry.name : `${items.length} ${noun.value}`,
)

/** Something could still be stopped, or deleted by Cancel */
const canCancel = computed(() => !discarding.value && (!finished.value || doneCount.value > 0))

/** The encode that's running: its speed tells how long the rest takes */
const current = computed(() => items.find((i) => i.state === 'compressing') ?? null)

const speedText = computed(() => {
  const item = current.value
  if (!item) return ''
  if (item.queued) return 'waiting for another compression on the server…'
  // photos take a second or so: no speed to show
  if (item.entry.kind === 'image') return ''
  return item.speed ? `${item.speed.toFixed(2)}× real time` : 'starting…'
})

/** Time left at the current speed */
const etaText = computed(() => {
  const speed = current.value?.speed
  if (!speed) return ''
  const secs = remainingWeight.value / speed
  if (secs < 60) return `${Math.ceil(secs)} s left`
  if (secs < 3600) return `${Math.round(secs / 60)} min left`
  return `${(secs / 3600).toFixed(1)} h left`
})

function savingOf(item: Item): number {
  return item.before && item.after !== null ? Math.round((1 - item.after / item.before) * 100) : 0
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'Failed'
}

async function compress(item: Item) {
  item.state = 'compressing'
  const job = compressVideo(item.entry.path, (p) => {
    item.queued = p.queued
    item.fraction = p.fraction
    item.speed = p.speed
  })
  running.add(job)
  try {
    const result = await job.done
    item.before = result.before
    item.after = result.after
    item.state = result.compressed ? 'done' : 'skipped'
    item.copyPath = result.path ?? ''
    item.note = result.compressed ? `Saved as ${result.name ?? 'a copy'}` : (result.note ?? '')
  } catch (e) {
    if (e instanceof CompressCancelled) {
      item.state = 'cancelled'
    } else {
      item.state = 'failed'
      item.note = message(e)
    }
  } finally {
    running.delete(job)
  }
}

/** One at a time: each takes the next waiting file until none are left */
async function worker() {
  for (;;) {
    const next = items.find((i) => i.state === 'waiting') // skips ones stopped before their turn
    if (!next) return
    await compress(next)
  }
}

function start() {
  allEnded = worker().then(() => {
    finished.value = true
  })
}

/**
 * Stop: stops the running compression (the server keeps nothing of it) and
 * skips the ones still waiting. The copies already saved stay.
 */
function stopAll() {
  for (const item of items) if (item.state === 'waiting') item.state = 'cancelled'
  for (const job of running) job.cancel()
}

/** Cancel: stops everything like Stop, then deletes the copies already saved */
async function cancelAll() {
  if (discarding.value) return
  discarding.value = true
  stopAll()
  // a copy can still be saved while being stopped: wait, so it's deleted too
  await allEnded
  for (const item of items) {
    if (item.state !== 'done' || !item.copyPath) continue
    try {
      await discardCompressed(item.copyPath)
      item.state = 'discarded'
      item.after = null
      item.note = ''
    } catch (e) {
      // it stays in the folder: say so
      item.note = `${item.note} · not discarded: ${message(e)}`
    }
  }
  discarding.value = false
}

function close() {
  if (!finished.value || discarding.value) return
  if (items.some((i) => i.state === 'done' || i.state === 'discarded')) emit('changed')
  emit('close')
}

/** Leaving or reloading the page would stop the compression: ask first */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!finished.value || discarding.value) e.preventDefault()
}

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  start()
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  // closing mid-way keeps the copies already saved, like Stop
  stopAll()
})
</script>

<template>
  <ModalDialog
    :title="title"
    :subtitle="subtitle"
    :locked="!finished || discarding"
    @close="close"
  >
    <!-- Whole batch -->
    <div class="overall">
      <div class="bar" :class="{ finished, failed: finished && countOf('failed') === items.length }">
        <div class="fill" :style="{ width: `${finished ? 100 : percent}%` }" />
      </div>
      <div class="overall-text">
        <span>{{ summary }}</span>
        <span v-if="!finished">{{ Math.floor(percent) }}%</span>
      </div>
      <div v-if="!finished && !discarding" class="overall-text speed">
        <span>{{ speedText }}</span>
        <span>{{ etaText }}</span>
      </div>
    </div>

    <!-- Before and after of the whole batch -->
    <div class="sizes">
      <div class="size-box">
        <span class="size-label">Before</span>
        <span class="size-value">{{ formatSize(totalBefore) }}</span>
      </div>
      <span class="size-arrow" aria-hidden="true">→</span>
      <div class="size-box">
        <span class="size-label">After</span>
        <span class="size-value" :class="{ smaller: saved > 0 }">{{ formatSize(totalAfter) }}</span>
      </div>
      <div class="size-box saved">
        <span class="size-label">Smaller by</span>
        <span class="size-value" :class="{ smaller: saved > 0 }">
          {{ saved > 0 ? `${formatSize(saved)} · ${savedPercent}%` : '—' }}
        </span>
      </div>
    </div>

    <!-- Each video -->
    <ul class="files">
      <li v-for="(item, i) in items" :key="i" class="file" :class="item.state">
        <div class="file-row">
          <span class="file-state" :title="item.state">
            <template v-if="item.state === 'done'">✓</template>
            <template v-else-if="item.state === 'skipped'">=</template>
            <template v-else-if="item.state === 'failed'">!</template>
            <template v-else-if="item.state === 'cancelled'">–</template>
            <template v-else-if="item.state === 'discarded'">✕</template>
            <span v-else-if="item.state === 'compressing'" class="spinner" />
            <template v-else>•</template>
          </span>
          <span class="file-name" :title="item.entry.name">{{ item.entry.name }}</span>
          <span class="file-size">
            <template v-if="item.state === 'compressing'">
              {{
                item.queued
                  ? 'waiting'
                  : item.entry.kind === 'image'
                    ? 'compressing…'
                    : `${Math.floor(item.fraction * 100)}%`
              }}
            </template>
            <template v-else-if="item.state === 'done'">
              {{ formatSize(item.before) }} → {{ formatSize(item.after ?? item.before) }}
              <span class="saving">−{{ savingOf(item) }}%</span>
            </template>
            <template v-else>{{ formatSize(item.before) }}</template>
          </span>
        </div>
        <div v-if="item.state === 'compressing' && item.entry.kind !== 'image'" class="bar small">
          <div class="fill" :style="{ width: `${item.fraction * 100}%` }" />
        </div>
        <p v-if="item.note" class="file-note">{{ item.note }}</p>
      </li>
    </ul>

    <p v-if="doneCount > 0 && !discarding" class="trash-note">
      The originals are untouched: delete them once you've checked the copies to free the space.
    </p>

    <!-- Cancel on its own at the left (deletes the copies); Stop and Done
         together at the right (keep the copies already saved) -->
    <div class="actions">
      <button
        class="button danger"
        :disabled="!canCancel"
        title="Stop and delete every copy this saved"
        @click="cancelAll"
      >
        {{ discarding ? 'Discarding…' : 'Cancel' }}
      </button>
      <span class="spacer" />
      <button
        class="button"
        :disabled="finished || discarding"
        title="Stop the rest; the copies already saved stay"
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
/* ── Progress bars (as in UploadDialog) ── */
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
  gap: 0.5rem;
  color: #aaa;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.overall-text.speed {
  color: #8f88aa;
}

/* ── Before / after ── */
.sizes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.7rem;
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.04);
}

.size-box {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.size-box.saved {
  margin-left: auto;
  text-align: right;
}

.size-label {
  color: #888;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.size-value {
  color: #ddd;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
}

.size-value.smaller {
  color: #6fdc8c;
}

.size-arrow {
  color: #666;
}

/* ── File list ── */
.files {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 40dvh;
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
.file.skipped,
.file.discarded {
  opacity: 0.6;
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

.saving {
  margin-left: 0.3rem;
  color: #6fdc8c;
}

.file-note {
  margin: 0.25rem 0 0 1.8rem;
  color: #999;
  font-size: 0.72rem;
}

.trash-note {
  margin: 0;
  color: #8f88aa;
  font-size: 0.75rem;
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

/* throws the copies away: red text, like the upload dialog's Cancel */
.button.danger {
  color: #f07060;
  border-color: rgba(231, 76, 60, 0.35);
}

.button.danger:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  color: #ff8a7a;
}
</style>
