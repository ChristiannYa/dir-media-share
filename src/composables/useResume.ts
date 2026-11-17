import { onUnmounted } from 'vue'
import { RESUME_STORAGE_KEY } from '@/constants'

/**
 * Where the app was when it locked, so unlocking returns exactly there: the
 * open folder and how far down it was scrolled, the photo / video open in
 * the viewer, whether it was fullscreen (and the photo's turn), and the
 * video's time and whether it was paused.
 *
 * Each part of the app that knows a piece registers a function giving it
 * (onCaptureResume); locking (useLock) calls captureResume() while they're
 * all still on screen. Kept in sessionStorage too, so a reload of the tab
 * while locked still comes back to it. Unlocking: App takes the point
 * (takeResumePoint) to open the folder, scroll and open the viewer; the
 * viewer then takes its own part (takeViewerResume).
 */

export interface ResumePoint {
  /** The open folder */
  path: string
  /** How far down the page was scrolled (px) */
  scrollY: number
  /** The photo / video open in the viewer, or null */
  open: string | null
  /** The viewer's photo was fullscreen */
  photoFullscreen: boolean
  /** Its turn in fullscreen (0, 90, 180, 270°) */
  rotation: number
  /** The video player was fullscreen */
  videoFullscreen: boolean
  /** Where the video was (s); null if no video was open */
  videoTime: number | null
  videoPaused: boolean
}

/** What the viewer needs to put back */
export type ViewerResume = Pick<
  ResumePoint,
  'photoFullscreen' | 'rotation' | 'videoFullscreen' | 'videoTime' | 'videoPaused'
>

const DEFAULTS: ResumePoint = {
  path: '',
  scrollY: 0,
  open: null,
  photoFullscreen: false,
  rotation: 0,
  videoFullscreen: false,
  videoTime: null,
  videoPaused: false,
}

const capturers = new Set<() => Partial<ResumePoint>>()

/** Adds the calling component's piece of the resume point, while it's mounted */
export function onCaptureResume(capture: () => Partial<ResumePoint>) {
  capturers.add(capture)
  onUnmounted(() => capturers.delete(capture))
}

/** Notes where the app is now (call just before locking) */
export function captureResume() {
  const point: ResumePoint = { ...DEFAULTS }
  for (const capture of capturers) Object.assign(point, capture())
  try {
    sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(point))
  } catch {
    // storage unavailable (private window): nothing to come back to
  }
}

/** The viewer's part, until the viewer opens that item and takes it */
let viewer: { path: string; resume: ViewerResume } | null = null

/** Where the app was when it locked, once (it's forgotten after); null if nothing was noted */
export function takeResumePoint(): ResumePoint | null {
  let point: ResumePoint | null = null
  try {
    const saved = sessionStorage.getItem(RESUME_STORAGE_KEY)
    sessionStorage.removeItem(RESUME_STORAGE_KEY)
    if (saved) point = { ...DEFAULTS, ...(JSON.parse(saved) as Partial<ResumePoint>) }
  } catch {
    // unreadable or unavailable: start fresh
  }
  viewer = point?.open ? { path: point.open, resume: point } : null
  return point
}

/** The viewer's part, if `path` is the item that was open when it locked (once) */
export function takeViewerResume(path: string): ViewerResume | null {
  if (viewer?.path !== path) return null
  const { resume } = viewer
  viewer = null
  return resume
}
