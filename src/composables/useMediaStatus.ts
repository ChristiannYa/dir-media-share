import { onScopeDispose, ref, watch, type Directive, type InjectionKey } from 'vue'
import { settings } from '@/settings'
import type { Entry } from '@/types'
import { isMediaEntry } from '@/utils/entry'

function withPath(set: Set<string>, path: string): Set<string> {
  return new Set([...set, path])
}

function withoutPath(set: Set<string>, path: string): Set<string> {
  const next = new Set(set)
  next.delete(path)
  return next
}

/**
 * Loading state of every thumbnail and preview in the grid.
 *
 * Previews have two distances (tracked with `vVisible`):
 * - on the screen (settings.previewRootMargin): the preview starts loading,
 *   and plays once loaded. A card that leaves the screen before its preview
 *   loaded drops it: the download stops and the server's build is cancelled,
 *   so the encoders work on what's on screen
 * - near the screen (settings.previewKeepMargin): a preview that did load is
 *   kept (paused), so scrolling back to it is instant
 * Cards scrolled further away drop their preview, so a huge folder doesn't
 * keep every clip in memory.
 */
export function useMediaStatus() {
  const loading = ref(new Set<string>()) // still image not loaded yet
  const thumbFailed = ref(new Set<string>())
  const near = ref(new Set<string>()) // close enough to keep the preview loaded
  const visible = ref(new Set<string>()) // on screen: the preview plays
  const previewLoaded = ref(new Set<string>()) // preview clip is downloaded (kept while near)
  const previewReady = ref(new Set<string>()) // preview clip has started playing
  const previewFailed = ref(new Set<string>())
  /** While true (lightbox open) grid previews are paused, freeing CPU for the opened video */
  const suspended = ref(false)

  // ── Visibility ──

  /**
   * Keeps `target` up to date with the paths of the cards within
   * `rootMargin()` of the screen. When the margin changes (Settings), the
   * observer is rebuilt and watches the same cards again.
   */
  function trackWithin(rootMargin: () => string, target: typeof visible) {
    let observer: IntersectionObserver | null = null
    /** Cards being watched, to hand over to a rebuilt observer */
    const watched = new Set<HTMLElement>()

    function get(): IntersectionObserver {
      observer ??= new IntersectionObserver(
        (items) => {
          const next = new Set(target.value)
          for (const item of items) {
            const path = (item.target as HTMLElement).dataset.path
            if (!path) continue
            if (item.isIntersecting) next.add(path)
            else next.delete(path)
          }
          target.value = next
        },
        { rootMargin: rootMargin() },
      )
      return observer
    }

    // a new observer reports every watched card once, so `target` refills itself
    watch(rootMargin, () => {
      observer?.disconnect()
      observer = null
      for (const el of watched) get().observe(el)
    })

    onScopeDispose(() => observer?.disconnect())
    return {
      observe(el: HTMLElement) {
        watched.add(el)
        get().observe(el)
      },
      unobserve(el: HTMLElement) {
        watched.delete(el)
        observer?.unobserve(el)
      },
    }
  }

  const nearTracker = trackWithin(() => settings.previewKeepMargin, near)
  const visibleTracker = trackWithin(() => settings.previewRootMargin, visible)

  /** The tracked cards, by path, to measure which are nearest the middle of the screen */
  const cards = new Map<string, HTMLElement>()

  /** `v-visible="entry.path"` tracks how close the card is to the screen */
  const vVisible: Directive<HTMLElement, string> = {
    mounted(el, binding) {
      el.dataset.path = binding.value
      cards.set(binding.value, el)
      nearTracker.observe(el)
      visibleTracker.observe(el)
    },
    updated(el, binding) {
      if (el.dataset.path !== binding.value) {
        if (el.dataset.path) cards.delete(el.dataset.path)
        cards.set(binding.value, el)
      }
      el.dataset.path = binding.value
    },
    unmounted(el) {
      if (el.dataset.path) cards.delete(el.dataset.path)
      nearTracker.unobserve(el)
      visibleTracker.unobserve(el)
    },
  }

  // ── Which previews play ──
  // Each playing preview is decoded and redrawn every frame, so only the
  // settings.maxPlayingPreviews nearest the middle of the screen play; the
  // rest show their still (and stay loaded, so they start right away).

  /** Paths whose preview plays */
  const playing = ref(new Set<string>())

  function sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const x of a) if (!b.has(x)) return false
    return true
  }

  function updatePlaying() {
    const max = settings.maxPlayingPreviews
    let next: Set<string>
    if (max <= 0 || visible.value.size <= max) {
      next = new Set(visible.value)
    } else {
      const midX = window.innerWidth / 2
      const midY = window.innerHeight / 2
      const byDistance = [...visible.value]
        .map((path) => {
          const rect = cards.get(path)?.getBoundingClientRect()
          const d = rect
            ? Math.hypot(rect.left + rect.width / 2 - midX, rect.top + rect.height / 2 - midY)
            : Infinity
          return { path, d }
        })
        .sort((a, b) => a.d - b.d)
      next = new Set(byDistance.slice(0, max).map((x) => x.path))
    }
    // a new Set every scroll would re-render every card: only when it changed
    if (!sameSet(next, playing.value)) playing.value = next
  }

  /** At most once per frame, however many scroll events come in */
  let pending = 0
  function schedulePlaying() {
    if (pending) return
    pending = requestAnimationFrame(() => {
      pending = 0
      updatePlaying()
    })
  }

  watch([visible, () => settings.maxPlayingPreviews], schedulePlaying)
  window.addEventListener('scroll', schedulePlaying, { passive: true })
  window.addEventListener('resize', schedulePlaying)
  onScopeDispose(() => {
    cancelAnimationFrame(pending)
    window.removeEventListener('scroll', schedulePlaying)
    window.removeEventListener('resize', schedulePlaying)
  })

  // ── Folder changes ──

  /** Forget everything about the previous folder */
  function reset() {
    extra = new Set()
    extraGroups = new Map()
    thumbFailed.value = new Set()
    near.value = new Set()
    visible.value = new Set()
    playing.value = new Set()
    previewLoaded.value = new Set()
    previewReady.value = new Set()
    previewFailed.value = new Set()
  }

  /** Pause (true) or resume (false) all grid previews; they stay loaded */
  function setSuspended(value: boolean) {
    suspended.value = value
  }

  /** Paths of the cards in the current listing */
  let listed = new Set<string>()
  /** Keys of the cards shown outside the listing (the "Most played" and "Hearted" sections) */
  let extra = new Set<string>()
  /** The same, per section ("most-played", "hearted"): `extra` is all of them together */
  let extraGroups = new Map<string, Set<string>>()

  /** Every image and video in a new listing starts out loading */
  function markLoading(entries: Entry[]) {
    loading.value = new Set(entries.filter(isMediaEntry).map((e) => e.path))
    listed = new Set(entries.map((e) => e.path))
  }

  /**
   * The same folder was listed again. Cards that are still there are already
   * loaded and on screen, and won't fire `load` or visibility events again,
   * so their state is kept; only new cards start loading, and cards that are
   * gone are forgotten.
   */
  function update(entries: Entry[]) {
    // the section's cards are still on screen: theirs is kept too
    const paths = new Set([...entries.map((e) => e.path), ...extra])
    const keep = (set: Set<string>) => new Set([...set].filter((p) => paths.has(p)))
    const added = entries.filter((e) => isMediaEntry(e) && !listed.has(e.path)).map((e) => e.path)

    loading.value = new Set([...keep(loading.value), ...added])
    thumbFailed.value = keep(thumbFailed.value)
    near.value = keep(near.value)
    visible.value = keep(visible.value)
    previewLoaded.value = keep(previewLoaded.value)
    previewReady.value = keep(previewReady.value)
    previewFailed.value = keep(previewFailed.value)
    listed = new Set(entries.map((e) => e.path))
  }

  /**
   * The cards shown outside the listing changed (the "Most played" section
   * loaded): new ones start loading, like a listing's; ones already shown
   * keep their state. `keyOf` gives each card's own key (GalleryCard's
   * statusKey), so a file shown in the grid too has a separate state there.
   * Each section (`group`) replaces only its own cards
   */
  function setExtra(
    entries: Entry[],
    keyOf: (entry: Entry) => string = (e) => e.path,
    group = 'most-played',
  ) {
    const added = entries
      .filter((e) => isMediaEntry(e) && !listed.has(keyOf(e)) && !extra.has(keyOf(e)))
      .map(keyOf)
    if (added.length) loading.value = new Set([...loading.value, ...added])
    extraGroups.set(group, new Set(entries.map(keyOf)))
    extra = new Set([...extraGroups.values()].flatMap((keys) => [...keys]))
  }

  // ── Events ──

  function onMediaLoad(path: string) {
    loading.value = withoutPath(loading.value, path)
  }

  function onMediaError(path: string) {
    loading.value = withoutPath(loading.value, path)
  }

  function onThumbError(path: string) {
    thumbFailed.value = withPath(thumbFailed.value, path)
    onMediaError(path)
  }

  function onPreviewLoaded(path: string) {
    previewLoaded.value = withPath(previewLoaded.value, path)
  }

  function onPreviewPlaying(path: string) {
    previewReady.value = withPath(previewReady.value, path)
  }

  function onPreviewError(path: string) {
    previewFailed.value = withPath(previewFailed.value, path)
  }

  // ── Queries ──

  const isThumbLoading = (path: string) => loading.value.has(path)
  const hasThumbFailed = (path: string) => thumbFailed.value.has(path)
  const isPreviewReady = (path: string) => previewReady.value.has(path)

  /**
   * The preview loads while its card is on screen; once loaded, it's kept
   * while the card is near the screen. A card that leaves the screen before
   * its preview loaded drops it, which stops the load (PreviewVideo cancels
   * the server's build when it's removed).
   */
  function showPreview(path: string): boolean {
    if (thumbFailed.value.has(path) || previewFailed.value.has(path)) return false
    if (visible.value.has(path)) return true
    return near.value.has(path) && previewLoaded.value.has(path)
  }

  /**
   * The preview plays only while its card is on screen, among the
   * maxPlayingPreviews nearest the middle, and the lightbox is closed
   */
  function isPreviewActive(path: string): boolean {
    return playing.value.has(path) && !suspended.value
  }

  /**
   * On screen, but its preview doesn't play: held back by maxPlayingPreviews
   * (not among the nearest the middle). Not while the lightbox is open: the
   * grid is covered then
   */
  function isHeldBack(path: string): boolean {
    return visible.value.has(path) && !playing.value.has(path) && !suspended.value
  }

  /** Videos, and folders with something to preview, get an auto-playing preview */
  function hasPreview(entry: Entry): boolean {
    return entry.kind === 'video' || (entry.kind === 'folder' && entry.has_preview === true)
  }

  /**
   * While true, the card's ring spins and the loading dots run. A preview only
   * counts while it's meant to play: one held back by maxPlayingPreviews
   * shows its still, which is finished, not loading
   */
  function isLoading(entry: Entry, key = entry.path): boolean {
    if (loading.value.has(key)) return true
    if (!hasPreview(entry)) return false
    return isPreviewActive(key) && showPreview(key) && !previewReady.value.has(key)
  }

  return {
    vVisible,
    reset,
    setSuspended,
    markLoading,
    update,
    setExtra,
    onMediaLoad,
    onMediaError,
    onThumbError,
    onPreviewLoaded,
    onPreviewPlaying,
    onPreviewError,
    isThumbLoading,
    hasThumbFailed,
    isPreviewReady,
    showPreview,
    isPreviewActive,
    isHeldBack,
    hasPreview,
    isLoading,
  }
}

export type MediaStatus = ReturnType<typeof useMediaStatus>

/** Provided by App, injected by each GalleryCard */
export const MEDIA_STATUS_KEY: InjectionKey<MediaStatus> = Symbol('media-status')
