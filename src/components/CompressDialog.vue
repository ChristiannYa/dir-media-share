<script setup lang="ts">
import { computed, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { cancelCompress, clearCompressJobs } from '@/api'
import { compressPercent, useCompressQueue } from '@/composables/useCompressQueue'
import { revealInGallery } from '@/composables/useGallery'
import type { CompressJob, CompressJobState } from '@/types'
import { formatSize } from '@/utils/format'
import { haptic } from '@/utils/haptics'

/**
 * How the server's compress queue is going (useCompressQueue), opened from
 * the top bar's button (CompressButton.vue). The server compresses in the
 * background, so this can be closed and opened again at any time: nothing
 * stops when it closes.
 *
 * One section per folder, in the order they were queued, each with its own
 * progress. Each copy is saved next to its original, named after the
 * settings used ("clip [x264 crf20 slow].mp4"); the originals are never
 * touched. The edit dialog's trimmed / cropped copies ("clip_edited.mp4") are
 * in the same queue, marked "edit". Per file: stop it (waiting or
 * compressing). Per folder and for everything: stop the rest, clear the ended
 * ones from the list. A copy is deleted in the gallery, like any file.
 */
const emit = defineEmits<{ close: [] }>()

const { list, byFolder, activeCount, current, remainingWeight, isActive } = useCompressQueue()

/**
 * A tap on a file's row closes the popup and goes to its card in the gallery
 * (App.vue: its folder opens first, then the card is scrolled to the middle
 * and flashes): the saved copy once the job is done, else the original. That
 * includes an edit that is compressed right after: its edited copy is kept out
 * of the gallery until the compression ends, so the original is what's there
 */
function goTo(job: CompressJob) {
  haptic('tap')
  const target = job.state === 'done' && job.copyPath ? job.copyPath : job.path
  emit('close')
  void revealInGallery(target)
}

/** Requests on their way, by job id / folder / 'all', so their buttons wait */
const busy = ref(new Set<string>())
const error = ref<string | null>(null)

async function act(key: string, action: () => Promise<void>) {
  if (busy.value.has(key)) return
  busy.value.add(key)
  error.value = null
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed'
  } finally {
    busy.value.delete(key)
  }
}

const stopJob = (job: CompressJob) => act(job.id, () => cancelCompress({ id: job.id }))
const stopFolder = (folder: string) => act(`stop:${folder}`, () => cancelCompress({ folder }))
const clearFolder = (folder: string) => act(`clear:${folder}`, () => clearCompressJobs(folder))
const stopAll = () => act('stop-all', () => cancelCompress('all'))
const clearAll = () => act('clear-all', () => clearCompressJobs())

const endedCount = computed(() => list.value.length - activeCount.value)

/** What the queue holds: only compressions, only edits, or both */
const actions = computed(() => {
  const edits = list.value.some((j) => j.action === 'edit')
  const compressions = list.value.some((j) => j.action !== 'edit')
  return edits && compressions ? 'both' : edits ? 'edit' : 'compress'
})

const title = computed(() => {
  if (list.value.length === 0) return 'Compressions'
  const running = activeCount.value > 0
  if (actions.value === 'edit') return running ? 'Editing…' : 'Edits finished'
  if (actions.value === 'both') return running ? 'Compressing and editing…' : 'All finished'
  return running ? 'Compressing…' : 'Compressions finished'
})

const subtitle = computed(() => {
  const n = list.value.length
  if (n === 0) return 'Nothing in the queue'
  const files = `${n} ${n === 1 ? 'file' : 'files'}`
  return activeCount.value > 0 ? `${files} · ${activeCount.value} left` : files
})

const overallPercent = computed(() => compressPercent(list.value))

const speedText = computed(() => {
  const job = current.value
  if (!job) return activeCount.value > 0 ? 'waiting…' : ''
  if (job.kind === 'image') {
    const cropping = job.action === 'edit' && !(job.compressAfter && job.fraction >= 0.5)
    return `${cropping ? 'cropping' : 'compressing'} ${job.name}`
  }
  return job.speed ? `${job.speed.toFixed(2)}× real time` : 'starting…'
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

/**
 * Size of the files that got a compressed copy, and of those copies: the
 * popup's top Before → After, everything in the list added up (an edit
 * compressed too counts its original's size; edits alone have no `after`)
 */
function sizes(jobs: CompressJob[]) {
  let before = 0
  let after = 0
  for (const j of jobs) {
    if (j.state !== 'done' || j.before === null || j.after === null) continue
    before += j.before
    after += j.after
  }
  return { before, after, saved: before - after }
}

const totals = computed(() => sizes(list.value))

/** The folder's name, and where it is (its parents) on the line under it */
function folderName(folder: string): string {
  return folder.split('/').at(-1) || 'Shared folder'
}

function folderParent(folder: string): string {
  return folder.split('/').slice(0, -1).join(' / ')
}

/** "3 compressed · 1 edited · 1 edited & compressed · 1 failed", or how many are left while it runs */
function folderSummary(jobs: CompressJob[]): string {
  const left = jobs.filter(isActive).length
  const parts: string[] = []
  if (left) parts.push(`${left} of ${jobs.length} left`)
  const count = (state: CompressJobState) => jobs.filter((j) => j.state === state).length
  const done = jobs.filter((j) => j.state === 'done')
  const compressed = done.filter((j) => j.action !== 'edit').length
  const edited = done.filter((j) => j.action === 'edit' && j.after === null).length
  const editedCompressed = done.filter((j) => j.action === 'edit' && j.after !== null).length
  if (compressed) parts.push(`${compressed} compressed`)
  if (edited) parts.push(`${edited} edited`)
  if (editedCompressed) parts.push(`${editedCompressed} edited & compressed`)
  for (const [state, label] of [
    ['skipped', 'no copy made'],
    ['failed', 'failed'],
    ['cancelled', 'stopped'],
    ['discarded', 'discarded'],
  ] as const) {
    const n = count(state)
    if (n) parts.push(`${n} ${label}`)
  }
  return parts.join(' · ')
}

/**
 * An edit that is compressed right after: until the compression ends, the
 * edited copy isn't in the gallery (the server keeps it out of the listing),
 * only the original is, so that's where a tap on the row leads (goTo)
 */
function editThenCompress(job: CompressJob): boolean {
  return job.action === 'edit' && job.compressAfter && isActive(job)
}

/**
 * A compressed copy saved (a compression, or an edit compressed too): its
 * sizes (the original's → the copy's) are on the line under its name, where
 * the note would be: the note only says the same as the name already does
 */
function sizesBelow(job: CompressJob): boolean {
  return job.state === 'done' && job.after !== null
}

/** What the row says while an edit + compress job runs: which step, and what comes next */
function phaseNote(job: CompressJob): string {
  if (!editThenCompress(job)) return ''
  return job.fraction < 0.5
    ? 'Edited copy first, then it is compressed right after: only the compressed copy is kept'
    : 'Edited: now compressing it. The copy shows up in the gallery once it is compressed'
}

/** The tooltip of a row: the file it leads to */
function rowTitle(job: CompressJob): string {
  if (editThenCompress(job)) {
    return `Show ${job.name} in the gallery (the edited copy appears once it is compressed)`
  }
  return `Show ${job.state === 'done' && job.copyName ? job.copyName : job.name} in the gallery`
}

function savingOf(job: CompressJob): number {
  return job.before && job.after !== null ? Math.round((1 - job.after / job.before) * 100) : 0
}

function progressText(job: CompressJob): string {
  if (job.state === 'waiting') return 'in line'
  const percent = `${Math.floor(job.fraction * 100)}%`
  // edited, then compressed: the first half is the edit, the second the compression
  const compressing = job.action !== 'edit' || (job.compressAfter && job.fraction >= 0.5)
  if (job.kind === 'image') return compressing ? 'compressing…' : 'cropping…'
  if (job.action === 'edit' && job.compressAfter) {
    return `${compressing ? 'compressing' : 'editing'} ${percent}`
  }
  return percent
}
</script>

<template>
  <ModalDialog :title="title" :subtitle="subtitle" wide @close="emit('close')">
    <p v-if="list.length === 0" class="empty">
      Nothing is being compressed or edited. Use Compress in a file's menu, or on a selection;
      the trimmed / cropped copies saved from Edit show up here too.
    </p>

    <template v-else>
      <!-- Everything together -->
      <div class="overall">
        <div class="bar" :class="{ finished: activeCount === 0 }">
          <div class="fill" :style="{ width: `${activeCount === 0 ? 100 : overallPercent}%` }" />
        </div>
        <div class="overall-text">
          <span>{{ endedCount }} of {{ list.length }} ended</span>
          <span v-if="activeCount > 0">{{ Math.floor(overallPercent) }}%</span>
        </div>
        <div v-if="activeCount > 0" class="overall-text speed">
          <span class="ellipsis">{{ speedText }}</span>
          <span>{{ etaText }}</span>
        </div>
      </div>

      <div v-if="totals.saved > 0" class="sizes">
        <div class="size-box">
          <span class="size-label">Before</span>
          <span class="size-value">{{ formatSize(totals.before) }}</span>
        </div>
        <span class="size-arrow" aria-hidden="true">→</span>
        <div class="size-box">
          <span class="size-label">After</span>
          <span class="size-value smaller">{{ formatSize(totals.after) }}</span>
        </div>
        <div class="size-box saved">
          <span class="size-label">Smaller by</span>
          <span class="size-value smaller">
            {{ formatSize(totals.saved) }} ·
            {{ Math.round((totals.saved / totals.before) * 100) }}%
          </span>
        </div>
      </div>

      <!-- One section per folder -->
      <div class="folders">
        <section v-for="group in byFolder" :key="group.folder" class="folder">
          <header class="folder-head">
            <div class="folder-titles">
              <h3 class="folder-name" :title="group.folder || 'Shared folder'">
                📁 {{ folderName(group.folder) }}
              </h3>
              <p v-if="folderParent(group.folder)" class="folder-parent">
                {{ folderParent(group.folder) }}
              </p>
            </div>
            <span class="folder-percent">
              {{
                group.jobs.some(isActive)
                  ? `${Math.floor(compressPercent(group.jobs))}%`
                  : 'Ended'
              }}
            </span>
          </header>
          <div class="bar small" :class="{ finished: !group.jobs.some(isActive) }">
            <div class="fill" :style="{ width: `${compressPercent(group.jobs)}%` }" />
          </div>
          <div class="folder-summary">
            <span>{{ folderSummary(group.jobs) }}</span>
            <span class="folder-actions">
              <button
                v-if="group.jobs.some(isActive)"
                type="button"
                class="link-button danger"
                :disabled="busy.has(`stop:${group.folder}`)"
                title="Stop this folder's compressions; the copies already saved stay"
                @click="stopFolder(group.folder)"
              >
                Stop
              </button>
              <button
                v-if="group.jobs.some((j) => !isActive(j))"
                type="button"
                class="link-button"
                :disabled="busy.has(`clear:${group.folder}`)"
                title="Remove this folder's ended files from the list (the copies stay)"
                @click="clearFolder(group.folder)"
              >
                Clear
              </button>
            </span>
          </div>

          <ul class="files">
            <!-- the whole row leads to the file's card (its buttons don't) -->
            <li
              v-for="job in group.jobs"
              :key="job.id"
              class="file"
              :class="job.state"
              role="button"
              tabindex="0"
              :title="rowTitle(job)"
              @click="goTo(job)"
              @keydown.enter.self="goTo(job)"
              @keydown.space.self.prevent="goTo(job)"
            >
              <div class="file-row">
                <span class="file-state" :title="job.state">
                  <template v-if="job.state === 'done'">✓</template>
                  <template v-else-if="job.state === 'skipped'">=</template>
                  <template v-else-if="job.state === 'failed'">!</template>
                  <template v-else-if="job.state === 'cancelled'">–</template>
                  <template v-else-if="job.state === 'discarded'">✕</template>
                  <span v-else-if="job.state === 'compressing'" class="spinner" />
                  <template v-else>•</template>
                </span>
                <span
                  v-if="job.action === 'edit'"
                  class="file-tag"
                  :title="
                    job.compressAfter
                      ? 'A trimmed / cropped copy (Edit), compressed too'
                      : 'A trimmed / cropped copy (Edit)'
                  "
                >
                  {{ job.compressAfter ? 'edit + compress' : 'edit' }}
                </span>
                <span class="file-name">{{ job.name }}</span>
                <span class="file-size">
                  <template v-if="isActive(job)">{{ progressText(job) }}</template>
                  <!-- a saved copy's sizes are on the line below; here, the original's size otherwise -->
                  <template v-else-if="job.before && !sizesBelow(job)">
                    {{ formatSize(job.before) }}
                  </template>
                </span>
                <button
                  v-if="isActive(job)"
                  type="button"
                  class="icon-button"
                  :disabled="busy.has(job.id)"
                  aria-label="Stop"
                  title="Stop this one"
                  @click.stop="stopJob(job)"
                >
                  ✕
                </button>
              </div>
              <div
                v-if="job.state === 'compressing' && job.kind === 'video'"
                class="bar tiny"
              >
                <div class="fill" :style="{ width: `${job.fraction * 100}%` }" />
              </div>
              <!-- a compressed copy saved: the sizes take the place of the note -->
              <p v-if="sizesBelow(job)" class="file-note file-sizes">
                {{ formatSize(job.before ?? 0) }} → {{ formatSize(job.after ?? 0) }}
                <span class="saving">−{{ savingOf(job) }}%</span>
              </p>
              <p v-else-if="job.note || phaseNote(job)" class="file-note">
                {{ job.note || phaseNote(job) }}
              </p>
            </li>
          </ul>
        </section>
      </div>

      <p v-if="list.some((j) => j.state === 'done' && j.action !== 'edit')" class="trash-note">
        The originals are untouched: delete them once you've checked the copies to free the space.
      </p>
    </template>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button
        v-if="activeCount > 0"
        type="button"
        class="button danger"
        :disabled="busy.has('stop-all')"
        title="Stop every compression; the copies already saved stay"
        @click="stopAll"
      >
        Stop all
      </button>
      <span class="spacer" />
      <button
        v-if="endedCount > 0"
        type="button"
        class="button"
        :disabled="busy.has('clear-all')"
        title="Remove the ended files from the list (the copies stay)"
        @click="clearAll"
      >
        Clear ended
      </button>
      <button type="button" class="button primary" @click="emit('close')">Close</button>
    </div>
  </ModalDialog>
</template>

<style scoped>
.empty {
  margin: 0;
  color: #8f88aa;
  font-size: 0.85rem;
}

/* ── Progress bars (as in UploadDialog) ── */
.bar {
  height: 0.5rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.bar.small {
  height: 0.3rem;
}

.bar.tiny {
  height: 0.2rem;
  margin-top: 0.4rem;
}

.fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #2d6cdf, #8a5cf6);
  transition: width 0.3s linear;
}

.bar.finished .fill {
  background: #3fae62;
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

.ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* ── Folder sections ── */
.folders {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-height: 50dvh;
  overflow-y: auto;
}

.folder {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.65rem 0.7rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 0.75rem;
  background: rgba(255, 255, 255, 0.03);
}

.folder-head {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.folder-titles {
  flex: 1;
  min-width: 0;
}

.folder-name {
  margin: 0;
  overflow: hidden;
  color: #f0ecff;
  font-size: 0.88rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-parent {
  margin: 0.1rem 0 0;
  overflow: hidden;
  color: #777;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-percent {
  flex: none;
  color: #aaa;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.folder-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  color: #8f88aa;
  font-size: 0.72rem;
}

.folder-actions {
  display: flex;
  gap: 0.6rem;
}

/* ── File list ── */
.files {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin: 0.15rem 0 0;
  padding: 0;
  list-style: none;
}

/* a row is tapped to go to the file's card */
.file {
  padding: 0.5rem 0.6rem;
  border-radius: 0.55rem;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.1s;
  -webkit-tap-highlight-color: transparent;
}

.file:hover {
  background: rgba(255, 255, 255, 0.08);
}

.file:hover .file-name {
  color: #fff;
}

.file:active {
  transform: scale(0.985);
}

.file:focus-visible {
  outline: 2px solid #8a5cf6;
  outline-offset: 1px;
}

/* the parts of a row (state, tag, name, sizes, saving) are each colored their
   own way, so they need next to no space between them */
.file-row {
  display: flex;
  align-items: center;
  gap: 2px;
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

/* an edit, not a compression */
.file-tag {
  flex: none;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  background: rgba(245, 197, 24, 0.14);
  color: #f5c518;
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
  margin-left: 2px;
  color: #6fdc8c;
}

.file-sizes {
  font-variant-numeric: tabular-nums;
}

/* under the name: past the state icon (1.2rem) and the row's gap */
.file-note {
  margin: 0.25rem 0 0 calc(1.2rem + 2px);
  color: #999;
  font-size: 0.72rem;
  overflow-wrap: anywhere;
}

.trash-note {
  margin: 0;
  color: #8f88aa;
  font-size: 0.75rem;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.8rem;
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
.icon-button {
  flex: none;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  color: #aaa;
  font-size: 0.7rem;
  cursor: pointer;
}

.icon-button:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.18);
  color: #ff8a7a;
}

.link-button {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: #b4aec8;
  font-size: 0.72rem;
  cursor: pointer;
}

.link-button:hover:not(:disabled) {
  color: #fff;
}

.link-button.danger {
  color: #f07060;
}

.link-button.danger:hover:not(:disabled) {
  color: #ff8a7a;
}

.icon-button:disabled,
.link-button:disabled,
.button:disabled {
  opacity: 0.4;
  cursor: default;
}

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
