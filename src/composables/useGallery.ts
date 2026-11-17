import { computed, ref, type InjectionKey, type Ref } from 'vue'
import { fetchEntries, fetchInfo, setSharedCacheVersion } from '@/api'
import type { Crumb, Entry } from '@/types'

/**
 * Provided by App: lists the open folder again and resolves once the grid
 * shows the new listing, for actions that wait for their result to appear
 * (Fix TS closes its menu only then)
 */
export const RELOAD_GALLERY_KEY: InjectionKey<() => Promise<void>> = Symbol('reloadGallery')

/**
 * Provided by App: lists the open folder again, then scrolls to the card of
 * `path` and briefly outlines it (e.g. a folder just created). If it isn't in
 * the open folder (created inside a subfolder), it only reloads.
 */
export const REVEAL_ENTRY_KEY: InjectionKey<(path: string) => Promise<void>> =
  Symbol('revealEntry')

/**
 * Provided by App: selection mode (tapping a file picks it; the bar at the
 * bottom acts on the picked ones). `start(path)` turns it on with that file
 * already picked, from the Select button of a file's menu (FileMenu.vue);
 * `active` says whether it's on
 */
export const SELECTION_KEY: InjectionKey<{
  active: Readonly<Ref<boolean>>
  start: (path: string) => void
}> = Symbol('selection')

interface GalleryHooks {
  /** Called when leaving the current folder, before the new listing is fetched */
  onLeave?: () => void
  /** Called with the new listing, in the same tick it is shown */
  onEntries?: (entries: Entry[]) => void
  /** Called when the current folder is listed again (see `reload`), in the same tick */
  onReload?: (entries: Entry[]) => void
}

/** Folder navigation: current path, its listing and the breadcrumb trail */
export function useGallery(hooks: GalleryHooks = {}) {
  const rootFolderName = ref('')
  const currentPath = ref('')
  const entries = ref<Entry[]>([])

  const breadcrumbs = computed<Crumb[]>(() =>
    currentPath.value
      .split('/')
      .filter(Boolean)
      .map((name, i, arr) => ({
        name,
        path: arr.slice(0, i + 1).join('/'),
      })),
  )

  async function navigate(path: string) {
    currentPath.value = path
    hooks.onLeave?.()
    const data = await fetchEntries(path)
    hooks.onEntries?.(data)
    entries.value = data
  }

  /**
   * Lists the current folder again (e.g. after a file was moved out of it or
   * deleted). Unlike `navigate`, cards that are still there keep their state.
   */
  async function reload() {
    const path = currentPath.value
    const data = await fetchEntries(path)
    if (currentPath.value !== path) return // went to another folder meanwhile
    hooks.onReload?.(data)
    entries.value = data
  }

  /** Loads the shared folder's name and opens `path` (the top by default); resolves once it's listed */
  async function init(path = '') {
    const info = await fetchInfo()
    rootFolderName.value = info.folder_name
    // before the grid draws: its stills' URLs include it
    if (typeof info.cache_version === 'number') setSharedCacheVersion(info.cache_version)
    await navigate(path)
  }

  return { rootFolderName, currentPath, entries, breadcrumbs, navigate, reload, init }
}
