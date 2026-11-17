<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { discardUpload, fileUrl, uploadFile, type Upload } from '@/api'
import { SHRINK_PRESETS, SHRINK_TARGET_STORAGE_KEY } from '@/constants'
import type { Entry } from '@/types'
import { formatSize } from '@/utils/format'
import { ShrinkCancelled, shrinkImage, shrunkName } from '@/utils/shrinkImage'

/**
 * Saves copies of photos made to fit a file size (e.g. 500 KB), one after
 * another. Asks for the size first.
 *
 * The browser does the work (src/utils/shrinkImage.ts): it lowers the quality,
 * and scales the picture down only if that isn't enough; nothing is cropped.
 * Each copy is uploaded next to its photo, named after the size
 * ("beach [500KB].jpg"); the originals are never touched. For the batch:
 * - Stop: the copies already saved stay; the rest aren't made
 * - Cancel: also deletes the copies already saved
 */
const props = defineProps<{
  /** Photos to shrink (isShrinkable) */
  entries: Entry[]
}>()
/** `changed`: copies were saved (or deleted again), so the listing should be reloaded */
const emit = defineEmits<{ close: []; changed: [] }>()

type Unit = 'KB' | 'MB'
const UNIT_BYTES: Record<Unit, number> = { KB: 1024, MB: 1024 * 1024 }
/** Smallest size that can be asked for: below it photos turn into thumbnails */
const MIN_TARGET = 10 * 1024

// ── Picking the size ──

function loadTarget(): { amount: number; unit: Unit } {
  try {
    const saved = JSON.parse(localStorage.getItem(SHRINK_TARGET_STORAGE_KEY) ?? 'null') as {
      amount?: unknown
      unit?: unknown
    } | null
    if (saved && typeof saved.amount === 'number' && (saved.unit === 'KB' || saved.unit === 'MB')) {
      return { amount: saved.amount, unit: saved.unit }
    }
  } catch {
    // storage unavailable or broken: the default below
  }
  return { amount: 1, unit: 'MB' }
}

const initial = loadTarget()
const amount = ref<number | ''>(initial.amount)
const unit = ref<Unit>(initial.unit)

const targetBytes = computed(() =>
  typeof amount.value === 'number' && amount.value > 0
    ? Math.floor(amount.value * UNIT_BYTES[unit.value])
    : 0,
)
/** Goes into the copies' names: "500KB", "1.5MB" */
const targetLabel = computed(() => `${amount.value}${unit.value}`)

const targetProblem = computed(() => {
  if (!targetBytes.value) return 'Enter a size'
  if (targetBytes.value < MIN_TARGET) return 'Pick at least 10 KB'
  return null
})

/** Photos already at most the size: they're skipped */
const alreadySmall = computed(
  () => props.entries.filter((e) => e.size != null && e.size <= targetBytes.value).length,
)

function pickPreset(p: { amount: number; unit: Unit }) {
  amount.value = p.amount
  unit.value = p.unit
}

function isPreset(p: { amount: number; unit: Unit }) {
  return amount.value === p.amount && unit.value === p.unit
}

// ── Shrinking ──

type State =
  | 'waiting'
  | 'working'
  | 'done'
  /** No copy saved (already small enough…): `note` says why */
  | 'skipped'
  | 'failed'
  | 'cancelled'
  /** A copy was saved, then deleted again by Cancel */
  | 'discarded'

interface Item {
  entry: Entry
  state: State
  /** What it's doing now (working only) */
  step: string
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
      step: '',
      before: entry.size ?? 0,
      after: null,
      copyPath: '',
      note: '',
    }),
  ),
)

const started = ref(false)
const finished = ref(false)
/** Cancel is deleting the copies */
const discarding = ref(false)
/** Resolves once the batch has ended (finished, failed or stopped) */
let allEnded: Promise<void> = Promise.resolve()
/** The photo being worked on, so Stop / Cancel can stop it */
let controller: AbortController | null = null
let upload: Upload | null = null

const countOf = (state: State) => items.filter((i) => i.state === state).length
const doneCount = computed(() => countOf('done'))
const endedCount = computed(
  () => items.filter((i) => i.state !== 'waiting' && i.state !== 'working').length,
)
const percent = computed(() => (items.length ? (endedCount.value / items.length) * 100 : 0))

/** Size of the whole batch before, and with the copies in place of their photos */
const totalBefore = computed(() => items.reduce((sum, i) => sum + i.before, 0))
const totalAfter = computed(() => items.reduce((sum, i) => sum + (i.after ?? i.before), 0))
const saved = computed(() => totalBefore.value - totalAfter.value)
const savedPercent = computed(() =>
  totalBefore.value ? Math.round((saved.value / totalBefore.value) * 100) : 0,
)

const summary = computed(() => {
  if (!finished.value) return `${endedCount.value} of ${items.length} photos`
  const parts = [`${doneCount.value} reduced`]
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
  if (!started.value) return 'Reduce file size'
  if (discarding.value) return 'Discarding…'
  if (!finished.value) return 'Reducing…'
  return items.some((i) => i.state === 'discarded') ? 'Cancelled' : 'Finished'
})

const subtitle = computed(() =>
  items.length === 1
    ? `${items[0]!.entry.name}${items[0]!.before ? ` · ${formatSize(items[0]!.before)}` : ''}`
    : `${items.length} photos · ${formatSize(totalBefore.value)}`,
)

/** Something could still be stopped, or deleted by Cancel */
const canCancel = computed(() => !discarding.value && (!finished.value || doneCount.value > 0))

function savingOf(item: Item): number {
  return item.before && item.after !== null ? Math.round((1 - item.after / item.before) * 100) : 0
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'Failed'
}

/** Folder the photo is in ('' for the shared folder itself) */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(0, slash) : ''
}

async function shrink(item: Item, target: number, label: string) {
  item.state = 'working'
  controller = new AbortController()
  const { signal } = controller
  try {
    const result = await shrinkImage(fileUrl(item.entry.path), item.entry.name, target, {
      signal,
      onStep: (step) => (item.step = step),
    })
    item.before = result.before
    if (result.kind === 'skipped') {
      item.state = 'skipped'
      item.note = result.note
      return
    }

    const name = shrunkName(item.entry.name, label, result.ext)
    const file = new File([result.blob], name, { type: result.blob.type })
    item.step = 'Saving…'
    upload = uploadFile(dirOf(item.entry.path), file, (sent) => {
      item.step = `Saving… ${Math.floor((sent / file.size) * 100)}%`
    })
    const copy = await upload.done
    item.state = 'done'
    item.after = file.size
    item.copyPath = copy.path
    const resized =
      result.width !== result.originalWidth
        ? ` · resized from ${result.originalWidth}×${result.originalHeight} to ${result.width}×${result.height}`
        : ''
    item.note = `Saved as ${copy.name}${resized}`
  } catch (e) {
    if (e instanceof ShrinkCancelled || signal.aborted) {
      item.state = 'cancelled'
    } else {
      item.state = 'failed'
      item.note = message(e)
    }
  } finally {
    item.step = ''
    controller = null
    upload = null
  }
}

/** One at a time: the browser encodes on this device, and every photo uses it fully */
async function run(target: number, label: string) {
  for (;;) {
    const next = items.find((i) => i.state === 'waiting') // skips ones stopped before their turn
    if (!next) break
    await shrink(next, target, label)
  }
  finished.value = true
}

function start() {
  if (targetProblem.value || started.value) return
  try {
    localStorage.setItem(
      SHRINK_TARGET_STORAGE_KEY,
      JSON.stringify({ amount: amount.value, unit: unit.value }),
    )
  } catch {
    // storage unavailable (private window): just not remembered
  }
  started.value = true
  // the size can't change under a running batch
  allEnded = run(targetBytes.value, targetLabel.value)
}

/** Stop: stops the photo being worked on (no copy of it is kept) and skips the rest */
function stopAll() {
  for (const item of items) if (item.state === 'waiting') item.state = 'cancelled'
  controller?.abort()
  upload?.cancel()
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
      await discardUpload(item.copyPath)
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

const running = computed(() => started.value && (!finished.value || discarding.value))

function close() {
  if (running.value) return
  if (items.some((i) => i.state === 'done' || i.state === 'discarded')) emit('changed')
  emit('close')
}

/** Leaving or reloading the page would stop it: ask first */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (running.value) e.preventDefault()
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  // closing mid-way keeps the copies already saved, like Stop
  stopAll()
})
</script>

<template>
  <ModalDialog :title="title" :subtitle="subtitle" :locked="running" @close="close">
    <!-- ── Picking the size ── -->
    <form v-if="!started" class="form" @submit.prevent="start">
      <label class="field-label" for="shrink-amount">Make each copy at most</label>
      <div class="target">
        <input
          id="shrink-amount"
          v-model.number="amount"
          class="amount-input"
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          enterkeyhint="done"
        />
        <div class="units" role="radiogroup" aria-label="Unit">
          <button
            v-for="u in ['KB', 'MB'] as const"
            :key="u"
            type="button"
            class="unit"
            :class="{ active: unit === u }"
            role="radio"
            :aria-checked="unit === u"
            @click="unit = u"
          >
            {{ u }}
          </button>
        </div>
      </div>

      <div class="presets">
        <button
          v-for="p in SHRINK_PRESETS"
          :key="`${p.amount}${p.unit}`"
          type="button"
          class="preset"
          :class="{ active: isPreset(p) }"
          @click="pickPreset(p)"
        >
          {{ p.amount }} {{ p.unit }}
        </button>
      </div>

      <p v-if="targetProblem" class="error">{{ targetProblem }}</p>
      <p v-else-if="alreadySmall > 0" class="hint">
        {{
          alreadySmall === items.length
            ? items.length === 1
              ? 'It is already that small.'
              : 'They are all already that small.'
            : `${alreadySmall} of ${items.length} are already that small and will be skipped.`
        }}
      </p>
      <p class="hint">
        The quality is lowered first; the picture is only scaled down if that isn't enough. Nothing
        is cropped. Copies are saved next to the originals, which stay as they are. Camera details
        and location aren't kept in the copies.
      </p>

      <div class="actions">
        <span class="spacer" />
        <button type="button" class="button" @click="close">Cancel</button>
        <button type="submit" class="button primary" :disabled="!!targetProblem">
          Reduce to {{ amount || 0 }} {{ unit }}
        </button>
      </div>
    </form>

    <!-- ── Shrinking ── -->
    <template v-else>
      <div class="overall">
        <div
          class="bar"
          :class="{ finished, failed: finished && countOf('failed') === items.length }"
        >
          <div class="fill" :style="{ width: `${finished ? 100 : percent}%` }" />
        </div>
        <div class="overall-text">
          <span>{{ summary }}</span>
          <span v-if="!finished">{{ Math.floor(percent) }}%</span>
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
          <span class="size-value" :class="{ smaller: saved > 0 }">{{
            formatSize(totalAfter)
          }}</span>
        </div>
        <div class="size-box saved">
          <span class="size-label">Smaller by</span>
          <span class="size-value" :class="{ smaller: saved > 0 }">
            {{ saved > 0 ? `${formatSize(saved)} · ${savedPercent}%` : '—' }}
          </span>
        </div>
      </div>

      <!-- Each photo -->
      <ul class="files">
        <li v-for="(item, i) in items" :key="i" class="file" :class="item.state">
          <div class="file-row">
            <span class="file-state" :title="item.state">
              <template v-if="item.state === 'done'">✓</template>
              <template v-else-if="item.state === 'skipped'">=</template>
              <template v-else-if="item.state === 'failed'">!</template>
              <template v-else-if="item.state === 'cancelled'">–</template>
              <template v-else-if="item.state === 'discarded'">✕</template>
              <span v-else-if="item.state === 'working'" class="spinner" />
              <template v-else>•</template>
            </span>
            <span class="file-name" :title="item.entry.name">{{ item.entry.name }}</span>
            <span class="file-size">
              <template v-if="item.state === 'working'">{{ item.step }}</template>
              <template v-else-if="item.state === 'done'">
                {{ formatSize(item.before) }} → {{ formatSize(item.after ?? item.before) }}
                <span class="saving">−{{ savingOf(item) }}%</span>
              </template>
              <template v-else>{{ formatSize(item.before) }}</template>
            </span>
          </div>
          <p v-if="item.note" class="file-note">{{ item.note }}</p>
        </li>
      </ul>

      <p v-if="doneCount > 0 && !discarding" class="hint">
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
        <button class="button primary" :disabled="running" @click="close">Done</button>
      </div>
    </template>
  </ModalDialog>
</template>

<style scoped>
/* ── Picking the size ── */
.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.field-label {
  color: #aaa;
  font-size: 0.8rem;
}

.target {
  display: flex;
  gap: 0.5rem;
}

.amount-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--edge);
  border-radius: 0.7rem;
  background: rgba(0, 0, 0, 0.35);
  color: #eee;
  /* 16px+: iOS zooms the page into smaller inputs */
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color 0.12s;
}

.amount-input:focus {
  border-color: #2d6cdf;
}

.units {
  display: flex;
  padding: 0.2rem;
  border: 1px solid var(--edge);
  border-radius: 0.7rem;
  background: rgba(0, 0, 0, 0.35);
}

.unit,
.preset {
  border: 1px solid transparent;
  color: #aaa;
  cursor: pointer;
}

.unit {
  padding: 0 0.8rem;
  border-radius: 0.5rem;
  background: none;
  font-size: 0.85rem;
}

.unit.active {
  background: #2d6cdf;
  color: #fff;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.preset {
  padding: 0.35rem 0.7rem;
  border-color: var(--edge);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 0.78rem;
}

.preset:hover,
.unit:hover:not(.active) {
  color: #fff;
}

.preset.active {
  border-color: #2d6cdf;
  background: rgba(45, 108, 223, 0.25);
  color: #fff;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
}

.hint {
  margin: 0;
  color: #8f88aa;
  font-size: 0.75rem;
}

/* ── Progress bar (as in CompressDialog) ── */
.bar {
  height: 0.5rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
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

/* throws the copies away: red text, like the compress dialog's Cancel */
.button.danger {
  color: #f07060;
  border-color: rgba(231, 76, 60, 0.35);
}

.button.danger:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  color: #ff8a7a;
}
</style>
