import { computed, reactive, ref } from 'vue'
import { fetchCompressJobs } from '@/api'
import type { CompressJob } from '@/types'
import { haptic } from '@/utils/haptics'

/** Goes up each time Compress is pressed: the top bar's indicator pulses (CompressButton.vue) */
export const compressPulse = ref(0)

/**
 * Compress was just pressed: a tap of haptics and a pulse of the indicator,
 * right away (before the server has answered). Call it from the press itself,
 * as iPhones only allow haptics right after a tap
 */
export function pulseCompress() {
  haptic('tap')
  compressPulse.value++
}

/**
 * The server's compress queue (server/compressQueue.ts), live: the server
 * compresses in the background, so the app stays usable, and every change
 * arrives on the job events stream (useJobEvents calls applyCompressEvent).
 * The whole list is fetched again each time that stream (re)connects, so
 * nothing missed meanwhile stays out of date.
 *
 * One list for the whole app: the top bar's button (CompressButton.vue) and
 * its popup (CompressDialog.vue) read it; App reloads the open folder when a
 * copy is saved into it or deleted from it (onCompressFolderChanged).
 */

const jobs = reactive(new Map<string, CompressJob>())

/** Told the folder of a job whose copy was just saved or deleted */
const folderListeners = new Set<(folder: string) => void>()

function isActive(job: CompressJob): boolean {
  return job.state === 'waiting' || job.state === 'compressing'
}

/** A change pushed by the server: a job's new state, or the ended jobs cleared from the list */
export function applyCompressEvent(event: { job?: CompressJob; removed?: string[] }) {
  if (Array.isArray(event.removed)) {
    for (const id of event.removed) jobs.delete(id)
    return
  }
  const job = event.job
  if (!job || typeof job.id !== 'string') return
  const before = jobs.get(job.id)
  jobs.set(job.id, job)
  // a copy appeared (done) or went away (discarded) in that folder
  if ((job.state === 'done' || job.state === 'discarded') && before?.state !== job.state) {
    for (const listener of folderListeners) listener(job.folder)
  }
}

/** Fetches the whole list again (the stream just connected: events may have been missed) */
export async function refreshCompressQueue() {
  try {
    const list = await fetchCompressJobs()
    jobs.clear()
    for (const job of list) jobs.set(job.id, job)
  } catch (e) {
    console.warn(e)
  }
}

/** Forgets the list (the screen was locked); the next connection fetches it again */
export function clearCompressQueue() {
  jobs.clear()
}

/** Calls `listener` with the folder each time a copy is saved into it or deleted from it; returns a function that stops it */
export function onCompressFolderChanged(listener: (folder: string) => void): () => void {
  folderListeners.add(listener)
  return () => folderListeners.delete(listener)
}

/** Every job, oldest first */
const list = computed(() => [...jobs.values()].sort((a, b) => a.queuedAt - b.queuedAt))

/** The jobs grouped by folder, in the order each folder was first queued */
const byFolder = computed(() => {
  const groups = new Map<string, CompressJob[]>()
  for (const job of list.value) {
    let group = groups.get(job.folder)
    if (!group) groups.set(job.folder, (group = []))
    group.push(job)
  }
  return [...groups].map(([folder, folderJobs]) => ({ folder, jobs: folderJobs }))
})

/** Jobs still waiting or compressing */
const activeCount = computed(() => list.value.filter(isActive).length)

/** Paths of the files waiting or compressing now */
const activePaths = computed(
  () => new Set(list.value.filter(isActive).map((j) => j.path)),
)

/** The job compressing now (the video one, if a photo runs beside it) */
const current = computed(
  () =>
    list.value.find((j) => j.state === 'compressing' && j.kind === 'video') ??
    list.value.find((j) => j.state === 'compressing') ??
    null,
)

/**
 * Seconds of video a job stands for, which is what encoding time goes by
 * (unknown: counted as a minute). A photo takes about as long as a second of video
 */
export function compressWeight(job: CompressJob): number {
  if (job.kind === 'image') return 1
  return job.duration || 60
}

/** How much of `group` is done, 0–100, by weight (ended jobs count as done) */
export function compressPercent(group: CompressJob[]): number {
  let total = 0
  let done = 0
  for (const job of group) {
    const w = compressWeight(job)
    total += w
    if (!isActive(job)) done += w
    else if (job.state === 'compressing') done += w * job.fraction
  }
  return total ? Math.min(100, (done / total) * 100) : 0
}

/** Seconds of video not encoded yet, in the whole queue */
const remainingWeight = computed(() =>
  list.value.reduce((sum, j) => {
    if (j.state === 'waiting') return sum + compressWeight(j)
    if (j.state === 'compressing') return sum + compressWeight(j) * (1 - j.fraction)
    return sum
  }, 0),
)

/** The compress queue, live (see above) */
export function useCompressQueue() {
  return { list, byFolder, activeCount, activePaths, current, remainingWeight, isActive }
}
