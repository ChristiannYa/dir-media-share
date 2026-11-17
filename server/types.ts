// Request and response shapes. Keep in sync with src/types.ts in the Vue app.

export type EntryKind = 'folder' | 'image' | 'video' | 'file'

/** One item of a folder listing */
export interface Entry {
  name: string
  kind: EntryKind
  /** Relative to the shared folder */
  path: string
  size: number | null
  /** Seconds, videos only */
  duration: number | null
  /** Videos only: displayed size in pixels (rotation applied) and frame rate; null if unknown */
  width: number | null
  height: number | null
  fps: number | null
  /** True for MPEG-TS saved as .mp4 (browsers can't play these) */
  needs_fix: boolean
  /** Folders only: true if the folder itself (not a subfolder) holds videos or images to preview */
  has_preview: boolean
  /** Folders only: videos inside it, including subfolders */
  video_count: number | null
  /** Folders only: images inside it, including subfolders */
  image_count: number | null
  /**
   * When the file was added to this disk (ms since 1970): its creation time,
   * or its last change where the filesystem doesn't record creation
   */
  added: number | null
  /**
   * Folders only: when the newest video or image inside it (subfolders
   * included) was added, like `added`; null if it has none
   */
  last_added: number | null
  /**
   * Videos, photos and folders: when it, or a video / photo inside the folder
   * (subfolders included), was last played / shown in the viewer
   * (server/views.ts); null if never
   */
  last_viewed: number | null
  /** Files only: marked with the heart (server/favorites.ts) */
  favorite: boolean
  /**
   * Videos and photos: how many times it was played / shown in the viewer
   * (server/plays.ts). Folders: those of everything inside them added up
   * (subfolders included). Null for other files
   */
  plays: number | null
}

/** Layout of a storyboard grid. Tile `i` shows the video at `i * interval`. */
export interface Storyboard {
  /** Seconds between tiles */
  interval: number
  /** Number of tiles */
  count: number
  columns: number
  rows: number
  tile_width: number
  tile_height: number
}
