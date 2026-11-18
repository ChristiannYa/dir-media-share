export type EntryKind = 'folder' | 'image' | 'video' | 'file'

/** One item in a folder listing, as returned by /api/browse */
export interface Entry {
  name: string
  kind: EntryKind
  path: string
  size?: number | null
  /** seconds, videos only */
  duration?: number | null
  /** videos only: displayed size in pixels (rotation applied) and frame rate; null if unknown */
  width?: number | null
  height?: number | null
  fps?: number | null
  /** true for MPEG-TS saved as .mp4 (browsers can't play these) */
  needs_fix?: boolean
  /** folders only: true if the folder itself (not a subfolder) holds videos or images to preview */
  has_preview?: boolean
  /** folders only: videos inside, including subfolders */
  video_count?: number | null
  /** folders only: images inside, including subfolders */
  image_count?: number | null
  /** when the file was added to the server's disk (ms since 1970) */
  added?: number | null
  /** folders only: when the newest video or image inside (subfolders included) was added */
  last_added?: number | null
  /** videos, photos and folders: when it, or one inside the folder, was last played / shown in the viewer */
  last_viewed?: number | null
  /** files only: marked with the heart (shared by every device) */
  favorite?: boolean
  /** folders only: hearted videos and photos inside, including subfolders */
  favorite_count?: number | null
  /** files only: a compressed copy not opened yet, shown with the "Compressed!" banner (every device) */
  compressed_new?: boolean
  /**
   * videos and photos: how many times it was played / shown in the viewer;
   * folders: those of everything inside added up (shared by every device)
   */
  plays?: number | null
}

export type CompressJobState =
  | 'waiting'
  | 'compressing'
  | 'done'
  /** No copy saved (it would hardly shrink, HDR…): `note` says why */
  | 'skipped'
  | 'failed'
  | 'cancelled'
  /** A copy was saved, then deleted again */
  | 'discarded'

/** One file of the server's compress queue (server/compressQueue.ts) */
export interface CompressJob {
  id: string
  /** The original, inside the shared folder */
  path: string
  name: string
  /** Its folder ('' = the shared folder itself) */
  folder: string
  kind: 'video' | 'image'
  /** Seconds of video; null if unknown */
  duration: number | null
  state: CompressJobState
  /** 0–1 encoded (videos) */
  fraction: number
  /** × real time; null until known */
  speed: number | null
  before: number | null
  /** Size of the copy (done only) */
  after: number | null
  copyPath: string | null
  copyName: string | null
  note: string
  queuedAt: number
  endedAt: number | null
}

/** Returned by /api/info */
export interface ServerInfo {
  folder_name: string
  /** The cache version shared by every device (server/cacheVersion.ts) */
  cache_version?: number
}

/**
 * Returned by /api/storyboard: one image holding a grid of small frames.
 * Tile `i` (left to right, then top to bottom) shows the video at `i * interval`.
 */
export interface Storyboard {
  url: string
  /** seconds between tiles */
  interval: number
  count: number
  columns: number
  rows: number
  tile_width: number
  tile_height: number
}

/** A folder as returned by /api/folders */
export interface FolderRef {
  name: string
  path: string
}

/** A fact at the top of a card's or folder's menu (CardMenu), e.g. a date */
export interface MenuDetail {
  label: string
  value: string
  /** Smaller line under the value, e.g. how long ago the date was */
  note?: string
}

/** One action in a card's or folder's menu (CardMenu) */
export interface MenuItem {
  label: string
  /** Smaller line under the label */
  description?: string
  /** SVG path (24×24 viewBox) drawn before the label */
  icon?: string
  /**
   * Shown in place of the label while `run` is in progress. A function is
   * called on each render, so it can show live progress read from a ref.
   */
  busyLabel?: string | (() => string)
  /** Red text, for destructive actions */
  danger?: boolean
  /** Greyed out and not clickable; `disabledReason` is its tooltip */
  disabled?: boolean
  disabledReason?: string
  /**
   * Items next to each other in the list with the same `row` share one row,
   * side by side (each still its own button); without it, a row of its own
   */
  row?: string
  /** If set, the menu asks this first and only runs the action once confirmed */
  confirm?: {
    message: string
    /** Text of the button that goes ahead (default: the item's label) */
    confirmLabel?: string
  }
  /**
   * The action. Resolve to a short result ("Removed 3 files") to show it for
   * a moment before the menu closes, or to null to close right away.
   */
  run: () => Promise<string | null>
}

export interface Crumb {
  name: string
  path: string
}
