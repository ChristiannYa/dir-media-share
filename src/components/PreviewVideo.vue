<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { cancelPreviewJob, fetchPreviewInfo } from '@/api'
import { settings } from '@/settings'
import { isFirstPlay } from '@/utils/firstPlays'
import { previewHaptic } from '@/utils/haptics'
import { screenHz } from '@/utils/screenRate'
import { smoothSpeed } from '@/utils/smoothSpeed'
import { useJobEvents, type JobKind } from '@/composables/useJobEvents'

/**
 * An auto-playing preview clip that covers its card, with a small pill
 * saying what the load is doing. It downloads the clip itself (instead of
 * leaving it to <video>) so it can show progress and tell whether the clip
 * came from the browser's cache.
 */
const props = defineProps<{
  /** previewUrl() / folderPreviewUrl() of the entry */
  apiUrl: string
  /** Entry path, to match the server's progress events */
  path: string
  kind: JobKind
  /** Plays while true (card on screen); paused, but kept loaded, while false */
  active: boolean
}>()
const emit = defineEmits<{
  /** The clip is downloaded: the card may keep it while near the screen */
  loaded: []
  playing: []
  /** It played for the first time since the page loaded (the card pulses) */
  firstPlay: []
  error: []
}>()

type Phase =
  /** Waiting for the server's answer (it checks its cache, or builds the clip) */
  | 'asking'
  /** Clip is being downloaded (or read from the browser's cache) */
  | 'downloading'
  /** Clip is loaded, the video is starting */
  | 'starting'
  | 'playing'
  | 'failed'

/** Where the clip finally came from */
type Origin =
  /** Encoded by the server for this load */
  | 'encoded'
  /** Already built on the server, downloaded now */
  | 'server'
  /** Already in the browser's cache: no download at all */
  | 'cache'

const phase = ref<Phase>('asking')
const origin = ref<Origin | null>(null)
/** Download progress 0–1; null if the size is unknown */
const progress = ref<number | null>(null)
const objectUrl = ref<string | null>(null)
/** False once the pill has faded after the preview started (see settings.showPreviewStatus for turning it off) */
const showStatus = ref(true)
const video = ref<HTMLVideoElement | null>(null)
/** The browser refused to start it (play() was rejected), e.g. by an autoplay rule */
const blocked = ref(false)

// Start / pause explicitly (no `autoplay` attribute): the card decides when
// it plays, and a refusal shows up in the pill instead of a silent "Starting"
watch([() => props.active, video], ([active, el]) => {
  if (!el) return
  if (!active) {
    el.pause()
    return
  }
  el.play().then(
    () => (blocked.value = false),
    (e: unknown) => {
      // AbortError: paused again before it started, not a problem
      if (e instanceof DOMException && e.name === 'AbortError') return
      blocked.value = true
    },
  )
})

/** Frame rate of the clip, from the server; null until known */
const clipFps = ref<number | null>(null)

/**
 * Speed comes from this device's settings, not the clip (encoded at 1×), so
 * changing it applies to every preview on screen at once. With "Match screen
 * refresh" on, it's nudged to the nearest speed that moves evenly on this
 * screen, for this clip's frame rate.
 */
const playbackSpeed = computed(() =>
  settings.smoothPreviews
    ? smoothSpeed(settings.previewSpeed, clipFps.value, screenHz.value, settings.smoothMaxChange)
    : settings.previewSpeed,
)

watch(
  [video, playbackSpeed],
  ([el, speed]) => {
    if (!el) return
    el.defaultPlaybackRate = speed // kept if the element reloads its source
    el.playbackRate = speed
  },
  { immediate: true },
)

const { jobStatus, forgetJob, waitForJob } = useJobEvents()
const controller = new AbortController()
let lingerTimer: ReturnType<typeof setTimeout> | undefined
/**
 * The server is building the clip for this card. If the card goes away
 * meanwhile (scrolled off screen, folder left), the build is cancelled, so
 * the encoders work on the previews that are on screen instead.
 */
let buildingOnServer = false

/** True if the last request for `url` was answered by the browser's cache (nothing transferred) */
function cameFromBrowserCache(url: string): boolean {
  const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[]
  const last = entries.at(-1)
  return last !== undefined && last.transferSize === 0 && last.decodedBodySize > 0
}

async function load() {
  forgetJob(props.kind, props.path)
  const { signal } = controller
  try {
    // null: the server is building it; wait for its "done" event, then ask again
    let info = await fetchPreviewInfo(props.apiUrl, signal)
    const encodedNow = !info
    while (!info) {
      buildingOnServer = true
      if ((await waitForJob(props.kind, props.path, signal)) === 'failed') {
        buildingOnServer = false
        throw new Error('Encoding failed')
      }
      forgetJob(props.kind, props.path) // a stale "done" mustn't end the next wait at once
      info = await fetchPreviewInfo(props.apiUrl, signal)
    }
    buildingOnServer = false
    clipFps.value = info.fps ?? null
    const clipUrl = new URL(info.url, location.href).href

    phase.value = 'downloading'
    const res = await fetch(clipUrl, { signal })
    if (!res.ok || !res.body) throw new Error(`Clip failed (${res.status})`)
    const total = Number(res.headers.get('Content-Length')) || 0
    const reader = res.body.getReader()
    const chunks: BlobPart[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as BlobPart)
      received += value.byteLength
      progress.value = total ? received / total : null
    }

    // the timing entry is recorded just after the body ends
    await new Promise((resolve) => setTimeout(resolve, 0))
    origin.value =
      encodedNow || info.built ? 'encoded' : cameFromBrowserCache(clipUrl) ? 'cache' : 'server'
    const type = res.headers.get('Content-Type') ?? 'video/mp4'
    objectUrl.value = URL.createObjectURL(new Blob(chunks, { type }))
    phase.value = 'starting'
    emit('loaded')
  } catch {
    if (signal.aborted) return // card went away
    phase.value = 'failed'
    emit('error')
  }
}

function onPlaying() {
  if (phase.value === 'playing') return // fires again on every resume
  phase.value = 'playing'
  // the first time this preview plays since the page loaded: a buzz, and the
  // card pulses (not again when scrolled back to or its folder reopened)
  if (isFirstPlay(`${props.kind}:${props.path}`)) {
    previewHaptic()
    emit('firstPlay')
  }
  emit('playing')
  lingerTimer = setTimeout(() => (showStatus.value = false), settings.previewStatusLingerMs)
}

function onVideoError() {
  phase.value = 'failed'
  emit('error')
}

onMounted(load)
onUnmounted(() => {
  controller.abort()
  if (buildingOnServer) cancelPreviewJob(props.kind, props.path)
  clearTimeout(lingerTimer)
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
})

// ── Status pill ──

type Icon = 'server' | 'queued' | 'encoding' | 'download' | 'starting' | 'cache' | 'failed'

/** 24×24 icon paths (Material icons) */
const ICONS: Record<Icon, string> = {
  // cloud
  server:
    'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A6 6 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
  // hourglass
  queued: 'M6 2v6l4 4-4 4v6h12v-6l-4-4 4-4V2H6z',
  // wrench
  encoding:
    'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
  // arrow into tray
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  // play
  starting: 'M8 5v14l11-7z',
  // stacked drives
  cache:
    'M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z',
  // warning triangle
  failed: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
}

const status = computed<{ icon: Icon; text: string; busy: boolean }>(() => {
  switch (phase.value) {
    case 'asking': {
      const job = jobStatus(props.kind, props.path)
      if (job?.state === 'queued') {
        const place = job.position ? ` · #${job.position}` : ''
        return { icon: 'queued', text: `Queued on server${place}`, busy: true }
      }
      if (job?.state === 'encoding') {
        const percent = job.progress === undefined ? '' : ` ${Math.floor(job.progress * 100)}%`
        return { icon: 'encoding', text: `Encoding${percent}`, busy: true }
      }
      return { icon: 'server', text: 'Asking server', busy: true }
    }
    case 'downloading': {
      const percent = progress.value === null ? '' : ` ${Math.round(progress.value * 100)}%`
      return { icon: 'download', text: `Downloading${percent}`, busy: true }
    }
    case 'starting':
      if (blocked.value) return { icon: 'failed', text: 'Blocked by browser', busy: false }
      // loaded while off screen: waits, paused, until scrolled to
      if (!props.active) return { icon: 'starting', text: 'Ready', busy: false }
      return { icon: 'starting', text: 'Starting', busy: true }
    case 'playing':
      if (origin.value === 'cache') return { icon: 'cache', text: 'From browser cache', busy: false }
      if (origin.value === 'encoded') return { icon: 'encoding', text: 'Encoded now', busy: false }
      return { icon: 'download', text: 'From server cache', busy: false }
    case 'failed':
      return { icon: 'failed', text: 'Failed', busy: false }
  }
  return { icon: 'failed', text: 'Failed', busy: false }
})
</script>

<template>
  <div class="preview-video">
    <video
      v-if="objectUrl"
      ref="video"
      :src="objectUrl"
      :class="{ ready: phase === 'playing' }"
      muted
      loop
      playsinline
      @playing="onPlaying"
      @error="onVideoError"
    />
    <div
      v-if="settings.showPreviewStatus"
      class="status badge-glass"
      :class="{ busy: status.busy, failed: phase === 'failed', hidden: !showStatus }"
      :title="status.text"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICONS[status.icon]" /></svg>
      <span>{{ status.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.preview-video {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity 0.2s;
}

/* covers the still / folder icon once its first frame plays */
video.ready {
  opacity: 1;
}

/* ── Status pill ── */
.status {
  position: absolute;
  /* above the card's dark placeholder, which covers everything until the still loads */
  z-index: 1;
  /* top-left corner, across from the quality badge (top-right, GalleryCard.vue),
     same inset (tokens.css) */
  top: var(--badge-inset);
  left: var(--badge-inset);
  /* stays clear of the quality badge on narrow cards */
  max-width: calc(50% - var(--badge-inset));
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  /* the glass rim (.badge-glass, tokens.css: like the cards' info badges) is inside the old size */
  padding: calc(0.15rem - 1px) calc(0.45rem - 1px);
  border-radius: 999px;
  color: #ddd;
  font-size: 0.65rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity 0.4s;
}

.status svg {
  flex: none;
  width: 0.8rem;
  height: 0.8rem;
  fill: currentColor;
}

.status span {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* still working: the icon pulses */
.status.busy svg {
  animation: pulse 1s ease-in-out infinite alternate;
}

.status.failed {
  color: #ff6b5b;
}

.status.hidden {
  opacity: 0;
}

@keyframes pulse {
  to {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status.busy svg {
    animation: none;
  }
}
</style>
