// User settings: the tunable values of constants.ts, changeable in the app's
// Settings popup. The constants stay the defaults. Two kinds:
// - device: how the grid loads and plays previews (Grid), and what costs GPU
//   or depends on the screen size (Display). Depends on each screen, GPU and
//   connection, so each browser keeps its own (localStorage).
// - shared (groups marked `shared`): sort, preview speed, video player, menus,
//   look, background. The same on every device: saved on the server, in
//   config/shared-settings.json (server/sharedSettings.ts). This browser keeps
//   a copy so the app starts with them right away, then refreshes it.

import { reactive, watchEffect } from 'vue'
import {
  API,
  APP_FONT,
  APP_FONTS,
  CONTROLS_HIDE_DELAY_MS,
  DOUBLE_TAP_MS,
  FREQUENT_SETTINGS_MAX,
  GRID_COLUMNS,
  HAPTIC_MS,
  HAPTICS,
  HEARTED_COUNT,
  HOLD_SEEK_DELAY_MS,
  HOLD_SEEK_GAIN,
  HOLD_SEEK_MAX_SPEED,
  HOLD_SEEK_SPEED,
  LOADING_DOTS,
  LOOP_VIDEOS,
  MAX_PLAYING_PREVIEWS,
  MENU_STATUS_MS,
  MOST_PLAYED_COUNT,
  PREVIEW_KEEP_MARGIN,
  VIEW_AFTER_SECONDS,
  PREVIEW_ROOT_MARGIN,
  PREVIEW_SPEED,
  PREVIEW_STATUS_LINGER_MS,
  SCRUB_PREVIEW_WIDTH,
  SEEK_FEEDBACK_MS,
  SEEK_STEP_SECONDS,
  SEEK_TAP_ZONE,
  SETTINGS_STORAGE_KEY,
  SHARED_SETTINGS_STORAGE_KEY,
  SHOW_PREVIEW_STATUS,
  SKY_SHOOTING_STAR_EVERY,
  SKY_STAR_COUNT,
  SKY_STAR_DRIFT,
  SMOOTH_MAX_CHANGE,
  SMOOTH_PREVIEWS,
  SORT_BY,
  SORT_OPTIONS,
  type SortBy,
} from '@/constants'

export const DEFAULT_SETTINGS = {
  sortBy: SORT_BY as SortBy,
  mostPlayedCount: MOST_PLAYED_COUNT,
  heartedCount: HEARTED_COUNT,
  viewAfterSeconds: VIEW_AFTER_SECONDS,
  gridColumns: GRID_COLUMNS,
  loadingDots: LOADING_DOTS,
  previewRootMargin: PREVIEW_ROOT_MARGIN,
  previewKeepMargin: PREVIEW_KEEP_MARGIN,
  previewSpeed: PREVIEW_SPEED,
  maxPlayingPreviews: MAX_PLAYING_PREVIEWS,
  smoothPreviews: SMOOTH_PREVIEWS,
  smoothMaxChange: SMOOTH_MAX_CHANGE,
  showPreviewStatus: SHOW_PREVIEW_STATUS,
  previewStatusLingerMs: PREVIEW_STATUS_LINGER_MS,
  loopVideos: LOOP_VIDEOS,
  seekStepSeconds: SEEK_STEP_SECONDS,
  doubleTapMs: DOUBLE_TAP_MS,
  controlsHideDelayMs: CONTROLS_HIDE_DELAY_MS,
  seekTapZone: SEEK_TAP_ZONE,
  seekFeedbackMs: SEEK_FEEDBACK_MS,
  holdSeekDelayMs: HOLD_SEEK_DELAY_MS,
  holdSeekSpeed: HOLD_SEEK_SPEED,
  holdSeekGain: HOLD_SEEK_GAIN,
  holdSeekMaxSpeed: HOLD_SEEK_MAX_SPEED,
  scrubPreviewWidth: SCRUB_PREVIEW_WIDTH,
  haptics: HAPTICS,
  hapticMs: HAPTIC_MS,
  menuStatusMs: MENU_STATUS_MS,
  frequentSettingsMax: FREQUENT_SETTINGS_MAX,
  starCount: SKY_STAR_COUNT,
  shootingStarEvery: SKY_SHOOTING_STAR_EVERY,
  starDrift: SKY_STAR_DRIFT,
  // look: the CSS variables of styles/tokens.css. Keep these equal to the
  // values there; only settings that differ from them are applied (see below)
  font: APP_FONT,
  folderRadius: 1,
  videoRadius: 1,
  gridGap: 1,
  folderGap: 1,
  cardBorder: 1,
  ringWidth: 1,
  cardGlassWidth: 6,
  ringVibrancy: 1,
  ringSpin: true,
  themedFolderNames: true,
  glass: true,
  bgAnimated: true,
  bgBrightness: 1,
  bgDriftSeconds: 20,
  glassOpacity: 0.55,
  topbarDarkness: 0.72,
  folderDarknessRatio: 0.5,
  badgeDarkness: 0.32,
  badgeGlassRatio: 1,
  videoControlRatio: 0.3,
  lightboxDarkness: 0.6,
  lightboxRingWidth: 1,
  popupDarkness: 0.4,
}

export type Settings = typeof DEFAULT_SETTINGS
export type SettingKey = keyof Settings

/**
 * How a setting is shown and checked in the Settings popup. Also the shape
 * the server sends for its own settings (server/settings.ts), hence `key: string`.
 */
export type FieldSpec = { key: string; label: string; help: string } & (
  | { type: 'number'; min: number; max: number; step: number; unit?: string }
  | { type: 'boolean' }
  /** CSS margin, as IntersectionObserver takes it ("150px", "300% 0px") */
  | { type: 'margin' }
  | { type: 'select'; options: string[] }
)

export type SettingField = FieldSpec & { key: SettingKey }

/** A collapsible part inside a Settings section, holding some of its fields (by key) */
export interface Subsection {
  title: string
  keys: string[]
}

export interface FieldGroup<F extends FieldSpec = FieldSpec> {
  title: string
  fields: F[]
  /**
   * Splits the section into collapsible parts, in this order; fields listed
   * in none are shown first, above them
   */
  subsections?: Subsection[]
  /** Same on every device, saved on the server; otherwise kept per device */
  shared?: boolean
}

export const SETTING_GROUPS: Array<FieldGroup<SettingField>> = [
  {
    title: 'Sorting',
    shared: true,
    fields: [
      {
        key: 'sortBy',
        label: 'Sort by',
        help: 'Order of the files in a folder, biggest / longest / sharpest / newest first. Quality: most pixels first (4K, then 1440p, 1080p…), the higher frame rate first at the same size. Folders always come first',
        type: 'select',
        options: [...SORT_OPTIONS],
      },
    ],
  },
  {
    title: 'Most played',
    shared: true,
    fields: [
      {
        key: 'mostPlayedCount',
        label: 'Items shown',
        help: 'A section above the grid. In the folders inside .bin (e.g. .bin/cinema): their most played folders, by the plays of everything inside added up. In the folders inside those (e.g. .bin/cinema/annaralphs): their most played videos and photos (subfolders included); tapping one takes you to its card. A play counts when a video starts playing in the viewer, or a photo is shown there, on any device. 0 = no section',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
      },
      {
        key: 'heartedCount',
        label: 'Hearted shown',
        help: 'A section under "Most played", in the folders where it lists videos and photos (e.g. .bin/cinema/annaralphs, not .bin/cinema): random hearted videos and photos (subfolders included). When there are more than fit, one is swapped for another every few seconds. Tapping one takes you to its card. 0 = no section',
        type: 'number',
        min: 0,
        max: 50,
        step: 1,
      },
      {
        key: 'viewAfterSeconds',
        label: 'Counts as a view after',
        help: 'Seconds of a video you have to watch in the viewer or fullscreen before it counts as a view (and as "last viewed"), once per opening. Paused time, skipping and fast seeking don\'t add up. A shorter video counts once 90% of it was watched. Photos count when shown. 0 = as soon as it starts playing',
        type: 'number',
        min: 0,
        max: 600,
        step: 1,
        unit: 's',
      },
    ],
  },
  {
    title: 'Previews',
    shared: true,
    fields: [
      {
        key: 'previewSpeed',
        label: 'Preview speed',
        help: 'How fast previews play (1.3 = 30% faster). Applies instantly, nothing is re-encoded. Each device may still nudge it to match its screen (This device → Grid → Match screen refresh)',
        type: 'number',
        min: 0.25,
        max: 4,
        step: 0.05,
        unit: '×',
      },
    ],
  },
  {
    title: 'Grid',
    subsections: [
      { title: 'Layout', keys: ['gridColumns', 'loadingDots'] },
      { title: 'Loading', keys: ['previewRootMargin', 'previewKeepMargin', 'maxPlayingPreviews'] },
      { title: 'Smooth motion', keys: ['smoothPreviews', 'smoothMaxChange'] },
      { title: 'Status pill', keys: ['showPreviewStatus', 'previewStatusLingerMs'] },
    ],
    fields: [
      {
        key: 'gridColumns',
        label: 'Columns',
        help: 'Cards per row. The top bar and cards then sit in a centered column, like a phone screen (0 = as many as fit the window)',
        type: 'number',
        min: 0,
        max: 12,
        step: 1,
      },
      {
        key: 'loadingDots',
        label: 'Loading dots',
        help: 'Colored dots running around a card while it loads',
        type: 'number',
        min: 0,
        max: 12,
        step: 1,
      },
      {
        key: 'previewRootMargin',
        label: 'Play distance',
        help: 'How far outside the screen a preview already loads and plays (e.g. 150px). One that leaves this area before it loaded is cancelled, on the server too',
        type: 'margin',
      },
      {
        key: 'previewKeepMargin',
        label: 'Keep distance',
        help: 'How far away a preview that already loaded is kept, paused (e.g. 300% 0px = 3 screens above and below), so scrolling back is instant. Previews only start loading on screen. More uses more memory',
        type: 'margin',
      },
      {
        key: 'maxPlayingPreviews',
        label: 'Previews playing at once',
        help: 'Only this many previews play, the ones nearest the middle of the screen; the others show their still. Each playing one keeps the GPU busy (0 = all on screen play)',
        type: 'number',
        min: 0,
        max: 60,
        step: 1,
      },
      {
        key: 'smoothPreviews',
        label: 'Match screen refresh',
        help: 'Nudge each preview\'s speed to one that moves evenly on this screen (e.g. 1.3× → 1.33× at 120 Hz), so motion doesn\'t stutter',
        type: 'boolean',
      },
      {
        key: 'smoothMaxChange',
        label: 'Max nudge',
        help: 'How far the speed may move for smoothness. If no even speed is this close, the preview plays at exactly your speed',
        type: 'number',
        min: 0,
        max: 2,
        step: 0.05,
        unit: '×',
      },
      {
        key: 'showPreviewStatus',
        label: 'Preview status pill',
        help: 'Show what each preview is doing (asking, encoding, downloading…)',
        type: 'boolean',
      },
      {
        key: 'previewStatusLingerMs',
        label: 'Status pill stays for',
        help: 'Once a preview plays, how long its pill stays before fading',
        type: 'number',
        min: 0,
        max: 30000,
        step: 100,
        unit: 'ms',
      },
    ],
  },
  {
    // what depends on this device's GPU and screen, so each keeps its own
    title: 'Display',
    subsections: [
      { title: 'GPU load', keys: ['glass', 'ringSpin', 'bgAnimated'] },
      { title: 'Glass', keys: ['topbarDarkness'] },
      { title: 'Screen size', keys: ['scrubPreviewWidth'] },
    ],
    fields: [
      {
        key: 'topbarDarkness',
        label: 'Top bar darkness',
        help: 'How dark the top bar\'s glass is (0 = no dark layer, 1 = solid black). Below 1 it stays see-through. Folder cards follow it (App → Look → Folder darkness ratio)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.02,
      },
      {
        key: 'glass',
        label: 'Glass effect',
        help: 'Frosted, blurred glass behind folder cards, the top bar and dialogs. Off: plain see-through panels, much lighter on the GPU. The photo / video viewer keeps its glass either way: the previews and sky behind it are paused while it\'s open, so it costs little',
        type: 'boolean',
      },
      {
        key: 'ringSpin',
        label: 'Loading ring spin',
        help: 'While a card loads, a bright arc sweeps around its ring. Off: the ring just brightens (lighter on the GPU)',
        type: 'boolean',
      },
      {
        key: 'bgAnimated',
        label: 'Animated background',
        help: 'Moving nebula, twinkling stars, shooting stars. Off: the sky is drawn once and stays still, so the background costs the GPU nothing',
        type: 'boolean',
      },
      {
        key: 'scrubPreviewWidth',
        label: 'Slider preview width',
        help: 'Width of the frame shown above the video player\'s slider',
        type: 'number',
        min: 80,
        max: 480,
        step: 10,
        unit: 'px',
      },
    ],
  },
  {
    // whether this phone vibrates is up to each device
    title: 'Haptics',
    fields: [
      {
        key: 'haptics',
        label: 'Haptic feedback',
        help: 'A light vibration when opening a folder or file, skipping, playing or pausing, going to the next photo / video, pressing Done here, the first time each preview plays (one buzz each, one after another), a double buzz when a video\'s view counts (the "+1" eye), and on the lock screen\'s keys and OK. Android phones; on iPhone (iOS 18+) only the ones that follow a tap',
        type: 'boolean',
      },
      {
        key: 'hapticMs',
        label: 'Haptic strength',
        help: 'How long each vibration lasts: longer feels stronger (a browser can\'t set the strength itself). Skips are a bit shorter. How hard the motor runs is set in the phone\'s settings (Sound & vibration → Vibration & haptics). Android only',
        type: 'number',
        min: 10,
        max: 150,
        step: 5,
        unit: 'ms',
      },
    ],
  },
  {
    title: 'Video player',
    subsections: [
      { title: 'Playback', keys: ['loopVideos'] },
      { title: 'Skipping', keys: ['seekStepSeconds', 'doubleTapMs', 'seekTapZone', 'seekFeedbackMs'] },
      {
        title: 'Hold to seek',
        keys: ['holdSeekDelayMs', 'holdSeekSpeed', 'holdSeekGain', 'holdSeekMaxSpeed'],
      },
    ],
    shared: true,
    fields: [
      {
        key: 'loopVideos',
        label: 'Loop videos',
        help: 'Start a video over from the beginning once it ends, instead of stopping',
        type: 'boolean',
      },
      {
        key: 'seekStepSeconds',
        label: 'Skip by',
        help: 'Seconds skipped by a double tap on a side, or the arrow keys',
        type: 'number',
        min: 1,
        max: 300,
        step: 1,
        unit: 's',
      },
      {
        key: 'doubleTapMs',
        label: 'Double-tap window',
        help: 'Max time between two taps for a double tap. A single tap on a side waits this long',
        type: 'number',
        min: 100,
        max: 1000,
        step: 10,
        unit: 'ms',
      },
      {
        key: 'seekTapZone',
        label: 'Skip zone width',
        help: 'Part of the video, on each side, that skips when double-tapped (0.3 = 30%)',
        type: 'number',
        min: 0.05,
        max: 0.5,
        step: 0.05,
      },
      {
        key: 'seekFeedbackMs',
        label: 'Skip bubble duration',
        help: 'How long the "+10s" bubble stays on screen',
        type: 'number',
        min: 100,
        max: 3000,
        step: 50,
        unit: 'ms',
      },
      {
        key: 'holdSeekDelayMs',
        label: 'Hold to seek after',
        help: 'Holding a side this long seeks continuously; slide away from where you pressed to go faster',
        type: 'number',
        min: 150,
        max: 1500,
        step: 10,
        unit: 'ms',
      },
      {
        key: 'holdSeekSpeed',
        label: 'Hold seek speed',
        help: 'Speed when the hold starts (2 = twice real time)',
        type: 'number',
        min: 0.5,
        max: 32,
        step: 0.5,
        unit: '×',
      },
      {
        key: 'holdSeekGain',
        label: 'Speed-up per 100px',
        help: 'Speed added for every 100px the finger slides away from where it pressed (in 0.1× steps)',
        type: 'number',
        min: 0.5,
        max: 50,
        step: 0.5,
        unit: '×',
      },
      {
        key: 'holdSeekMaxSpeed',
        label: 'Max hold seek speed',
        help: 'Fastest speed sliding can reach. Forward up to 16× plays smoothly; above that it jumps between frames',
        type: 'number',
        min: 1,
        max: 256,
        step: 0.5,
        unit: '×',
      },
    ],
  },
  {
    title: 'Full screen',
    shared: true,
    fields: [
      {
        key: 'controlsHideDelayMs',
        label: 'Hide controls after',
        help: "The video player's controls, and in photo fullscreen the photo counter, the fullscreen button and the lock timer, fade out after this long without interaction",
        type: 'number',
        min: 500,
        max: 30000,
        step: 100,
        unit: 'ms',
      },
    ],
  },
  {
    title: 'Menus',
    shared: true,
    fields: [
      {
        key: 'menuStatusMs',
        label: 'Result shown for',
        help: 'How long a menu action\'s result ("Removed 12 files") stays before the popup closes',
        type: 'number',
        min: 0,
        max: 10000,
        step: 100,
        unit: 'ms',
      },
      {
        key: 'frequentSettingsMax',
        label: 'Frequently changed settings',
        help: 'How many of the settings you change most are listed in a section at the top of every Settings tab (0 = no such section)',
        type: 'number',
        min: 0,
        max: 30,
        step: 1,
      },
    ],
  },
  {
    title: 'Look',
    subsections: [
      { title: 'Text', keys: ['font', 'themedFolderNames'] },
      { title: 'Cards', keys: ['folderRadius', 'videoRadius', 'gridGap', 'folderGap', 'cardBorder', 'cardGlassWidth'] },
      { title: 'Ring', keys: ['ringWidth', 'ringVibrancy'] },
      { title: 'Glass', keys: ['glassOpacity', 'folderDarknessRatio'] },
      { title: 'Badges', keys: ['badgeDarkness', 'badgeGlassRatio'] },
      {
        title: 'Viewer & player',
        keys: ['videoControlRatio', 'lightboxDarkness', 'lightboxRingWidth'],
      },
      { title: 'Popups', keys: ['popupDarkness'] },
    ],
    shared: true,
    fields: [
      {
        key: 'font',
        label: 'Font',
        help: 'Typeface of the whole app',
        type: 'select',
        options: Object.keys(APP_FONTS),
      },
      {
        key: 'folderRadius',
        label: 'Folder corners',
        help: 'Roundness of the folder cards (0 = square)',
        type: 'number',
        min: 0,
        max: 3,
        step: 0.125,
        unit: 'rem',
      },
      {
        key: 'videoRadius',
        label: 'Video corners',
        help: 'Roundness of the video and photo cards (0 = square)',
        type: 'number',
        min: 0,
        max: 3,
        step: 0.125,
        unit: 'rem',
      },
      {
        key: 'gridGap',
        label: 'Space between cards',
        help: 'Empty space between the cards of the grid, on top of what the ring and glass border take (phones use 3/4 of it)',
        type: 'number',
        min: 0,
        max: 4,
        step: 0.125,
        unit: 'rem',
      },
      {
        key: 'folderGap',
        label: 'Space between folders',
        help: 'Empty space around folder cards, like "Space between cards" but for folders only (phones use 3/4 of it). Between a folder and a photo / video it lands in between',
        type: 'number',
        min: 0,
        max: 4,
        step: 0.125,
        unit: 'rem',
      },
      {
        key: 'cardBorder',
        label: 'Card outline',
        help: 'Thin outline of folder cards. Taken from inside the card, so more shrinks the media',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        unit: 'px',
      },
      {
        key: 'ringWidth',
        label: 'Card ring',
        help: 'Thickness of the ring in the theme colors around hearted photos and videos, so they stand out (the others get the glass border instead). Drawn on the inside edge of the card, over the preview, so the grid spacing is untouched',
        type: 'number',
        min: 0,
        max: 10,
        step: 1,
        unit: 'px',
      },
      {
        key: 'cardGlassWidth',
        label: 'Glass border width',
        help: 'Thickness of the frosted glass border around folder cards, and around photos and videos that aren\'t hearted (hearted ones get the colored ring instead): the background shows through it, blurred. Same glass as the badges (Badge darkness, Badge glass ratio). 0 = none',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        unit: 'px',
      },
      {
        key: 'ringVibrancy',
        label: 'Ring vibrancy',
        help: 'How saturated the colors of the ring are: around hearted photos and videos in the grid, and around any opened one (1 = normal, 0 = grey, higher = more vivid)',
        type: 'number',
        min: 0,
        max: 3,
        step: 0.05,
        unit: '×',
      },
      {
        key: 'themedFolderNames',
        label: 'Colored folder names',
        help: 'Names of the folders inside cinema, know, leaks and rand fade through the same colors as the ring around videos',
        type: 'boolean',
      },
      {
        key: 'glassOpacity',
        label: 'Glass strength',
        help: 'How solid the glass of folder cards and the top bar is (0 = clear, 1 = most solid)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'folderDarknessRatio',
        label: 'Folder darkness ratio',
        help: 'How dark the folder cards\' glass is, as a share of the top bar darkness (This device → Display) (0.5 = half as dark, 1 = the same, 0 = no dark layer)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        unit: '×',
      },
      {
        key: 'badgeDarkness',
        label: 'Badge darkness',
        help: 'How dark the info badges on folder and video previews are (date, duration, size, quality, counts, and the loading status): 0 = no dark layer, 1 = solid black',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.02,
      },
      {
        key: 'badgeGlassRatio',
        label: 'Badge glass ratio',
        help: 'How strong the glass sheen of those badges is, as a share of Glass strength (1 = the same as folder cards, 0 = no sheen, just the dark layer and blur)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        unit: '×',
      },
      {
        key: 'videoControlRatio',
        label: 'Video control darkness ratio',
        help: 'How solid the colored glass of the video player\'s buttons and slider preview is, as a share of Glass strength (0.3 = 30% as solid, 1 = the same, 0 = clear)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        unit: '×',
      },
      {
        key: 'lightboxDarkness',
        label: 'Viewer background darkness',
        help: 'How dark the layer behind an opened photo or video is (0 = none, 1 = solid black). Below 1 the gallery shows faintly through it, blurred (always, even with Glass effect off)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'lightboxRingWidth',
        label: 'Viewer border',
        help: 'Thickness of the colored ring around an opened photo or video (0 = none)',
        type: 'number',
        min: 0,
        max: 10,
        step: 1,
        unit: 'px',
      },
      {
        key: 'popupDarkness',
        label: 'Popup background darkness',
        help: 'How dark the page gets behind a popup: Settings, the menus of files and folders, and every dialog (0 = none, 1 = solid black). Below 1 the page shows through it, blurred (with Glass effect on)',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    title: 'Background',
    subsections: [
      { title: 'Sky', keys: ['bgBrightness', 'bgDriftSeconds'] },
      { title: 'Stars', keys: ['starCount', 'shootingStarEvery', 'starDrift'] },
    ],
    shared: true,
    fields: [
      {
        key: 'bgBrightness',
        label: 'Brightness',
        help: 'Brightness of the night sky: its nebula clouds and stars (1 = normal, lower = darker, higher = brighter)',
        type: 'number',
        min: 0.2,
        max: 2,
        step: 0.05,
        unit: '×',
      },
      {
        key: 'bgDriftSeconds',
        label: 'Nebula drift time',
        help: 'How long the colored nebula clouds take to drift one way. Lower = faster, 0 = still',
        type: 'number',
        min: 0,
        max: 300,
        step: 1,
        unit: 's',
      },
      {
        key: 'starCount',
        label: 'Stars',
        help: 'How many stars are in the sky (0 = none). About a third gather in a faint Milky Way band',
        type: 'number',
        min: 0,
        max: 2000,
        step: 10,
      },
      {
        key: 'shootingStarEvery',
        label: 'Shooting star every',
        help: 'Average time between shooting stars; each comes a bit sooner or later (0 = none)',
        type: 'number',
        min: 0,
        max: 300,
        step: 1,
        unit: 's',
      },
      {
        key: 'starDrift',
        label: 'Star drift',
        help: 'How fast the stars slide sideways; far, small stars go slower than near ones (0 = still)',
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
        unit: 'px/s',
      },
    ],
  },
]


/** True if the browser accepts `value` as an IntersectionObserver margin */
function isValidMargin(value: string): boolean {
  try {
    new IntersectionObserver(() => {}, { rootMargin: value }).disconnect()
    return true
  } catch {
    return false
  }
}

/** Why `value` can't be used for `field`, or null if it's fine */
export function settingProblem(field: FieldSpec, value: unknown): string | null {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Must be on or off'
    case 'select':
      return typeof value === 'string' && field.options.includes(value)
        ? null
        : 'Pick one of the options'
    case 'margin':
      return typeof value === 'string' && value.trim() !== '' && isValidMargin(value.trim())
        ? null
        : 'Use px or % values, like 150px or 300% 0px'
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number'
      if (value < field.min || value > field.max) return `Between ${field.min} and ${field.max}`
      if (field.step >= 1 && !Number.isInteger(value)) return 'Whole numbers only'
      return null
  }
}

/** The groups kept per device, and the ones shared by every device */
export const DEVICE_GROUPS = SETTING_GROUPS.filter((g) => !g.shared)
export const SHARED_GROUPS = SETTING_GROUPS.filter((g) => g.shared)

const DEVICE_FIELDS = DEVICE_GROUPS.flatMap((g) => g.fields)
const SHARED_FIELDS = SHARED_GROUPS.flatMap((g) => g.fields)

/** Reads a JSON object from localStorage; {} if missing, unreadable or unavailable */
function readStored(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeStored(key: string, value: Record<string, unknown>) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable (private window): the change lasts until reload
  }
}

/** The valid values of `saved` for `fields`, on top of `into` */
function applySaved(into: Settings, fields: SettingField[], saved: Record<string, unknown>) {
  for (const field of fields) {
    const value = saved[field.key]
    if (value !== undefined && settingProblem(field, value) === null) {
      ;(into as Record<SettingKey, unknown>)[field.key] = value
    }
  }
}

/** The values of `fields` in `values` that differ from the defaults: what gets saved */
function changedFrom(values: Settings, fields: SettingField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((f) => values[f.key] !== DEFAULT_SETTINGS[f.key])
      .map((f) => [f.key, values[f.key]]),
  )
}

/**
 * This browser's settings on top of the defaults: its own device settings,
 * and its copy of the shared ones (refreshed from the server by
 * loadSharedSettings). Anything missing or invalid falls back.
 */
function load(): Settings {
  const result = { ...DEFAULT_SETTINGS }
  const shared = readStored(SHARED_SETTINGS_STORAGE_KEY)
  const own = readStored(SETTINGS_STORAGE_KEY)
  // settings that moved from shared to this device (glass, ring spin…) start
  // from this browser's copy of the shared value; its own saved value wins
  applySaved(result, DEVICE_FIELDS, { ...shared, ...own })
  // before settings were shared, this browser kept them with its own
  applySaved(result, SHARED_FIELDS, Object.keys(shared).length ? shared : own)
  // keep the moved values: the shared copy is rewritten without them
  writeStored(SETTINGS_STORAGE_KEY, changedFrom(result, DEVICE_FIELDS))
  return result
}

/** The current settings. Reactive: whatever reads them follows changes */
export const settings = reactive<Settings>(load())

/** Sends every shared value that differs from the defaults to the server, replacing what it had */
async function postShared(values: Record<string, unknown>): Promise<void> {
  const res = await fetch(API.sharedSettings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
  if (!res.ok) throw new Error(`Saving the shared settings failed (${res.status})`)
}

/**
 * Gets the shared settings from the server and applies them (call once at
 * startup). If the server has none saved yet, this browser's own become the
 * shared ones, so settings made before they were shared aren't lost.
 */
export async function loadSharedSettings(): Promise<void> {
  let saved: Record<string, unknown>
  try {
    const res = await fetch(API.sharedSettings)
    if (!res.ok) throw new Error(String(res.status))
    saved = ((await res.json()) as { values?: Record<string, unknown> }).values ?? {}
  } catch (e) {
    console.warn('Loading the shared settings failed; using this browser\'s copy', e)
    return
  }

  const mine = changedFrom(settings, SHARED_FIELDS)
  if (Object.keys(saved).length === 0 && Object.keys(mine).length > 0) {
    await postShared(mine).catch((e) => console.warn('Sharing this browser\'s settings failed', e))
    writeStored(SHARED_SETTINGS_STORAGE_KEY, mine)
    return
  }

  // the server's values; anything it doesn't have is at its default
  const next = { ...settings }
  for (const field of SHARED_FIELDS) {
    ;(next as Record<SettingKey, unknown>)[field.key] = DEFAULT_SETTINGS[field.key]
  }
  applySaved(next, SHARED_FIELDS, saved)
  Object.assign(settings, next)
  writeStored(SHARED_SETTINGS_STORAGE_KEY, changedFrom(settings, SHARED_FIELDS))
}

/** Look settings → CSS variable on <html>, with the unit it's written in */
const CSS_VARIABLES: Array<[SettingKey, string, string]> = [
  ['folderRadius', '--folder-radius', 'rem'],
  ['videoRadius', '--video-radius', 'rem'],
  ['gridGap', '--grid-gap', 'rem'],
  ['folderGap', '--folder-gap', 'rem'],
  ['cardBorder', '--card-border', 'px'],
  ['ringWidth', '--ring-width', 'px'],
  ['ringVibrancy', '--ring-vibrancy', ''],
  ['cardGlassWidth', '--card-glass-width', 'px'],
  ['glassOpacity', '--glass-opacity', ''],
  ['topbarDarkness', '--topbar-darkness', ''],
  ['folderDarknessRatio', '--folder-darkness-ratio', ''],
  ['badgeDarkness', '--badge-darkness', ''],
  ['badgeGlassRatio', '--badge-glass-ratio', ''],
  ['videoControlRatio', '--video-control-ratio', ''],
  ['lightboxDarkness', '--lightbox-darkness', ''],
  ['lightboxRingWidth', '--lightbox-ring-width', 'px'],
  ['popupDarkness', '--popup-darkness', ''],
]

// A changed look value overrides tokens.css on <html>; at its default the
// override is removed, so tokens.css stays in charge
watchEffect(() => {
  const style = document.documentElement.style
  for (const [key, variable, unit] of CSS_VARIABLES) {
    const value = settings[key]
    if (value === DEFAULT_SETTINGS[key]) style.removeProperty(variable)
    else style.setProperty(variable, `${value}${unit}`)
  }
})

// The picked font → --font-body on <html>; at the default, tokens.css's value
watchEffect(() => {
  const style = document.documentElement.style
  const stack = APP_FONTS[settings.font]
  if (settings.font === DEFAULT_SETTINGS.font || !stack) style.removeProperty('--font-body')
  else style.setProperty('--font-body', stack)
})

/** On/off look settings → a class on <html> while they're off (styles/ring.css, tokens.css) */
const OFF_CLASSES: Array<[SettingKey, string]> = [
  ['ringSpin', 'no-ring-spin'],
  ['glass', 'no-glass'],
]

watchEffect(() => {
  const classes = document.documentElement.classList
  for (const [key, className] of OFF_CLASSES) classes.toggle(className, settings[key] === false)
})

/**
 * Changes one setting right away and saves it (for controls outside the
 * Settings popup). A failed save of a shared one is only logged: it still
 * applies on this device until reload.
 */
export function setSetting<K extends SettingKey>(key: K, value: Settings[K]) {
  applySettings({ ...settings, [key]: value }).catch((e) => console.warn(e))
}

/**
 * Replaces every setting at once and saves only those that differ from the
 * default: device ones in this browser, shared ones on the server (if any of
 * them changed). Applies right away; rejects if the server couldn't save.
 */
export async function applySettings(next: Settings): Promise<void> {
  const sharedChanged = SHARED_FIELDS.some((f) => next[f.key] !== settings[f.key])
  Object.assign(settings, next)
  writeStored(SETTINGS_STORAGE_KEY, changedFrom(settings, DEVICE_FIELDS))
  const shared = changedFrom(settings, SHARED_FIELDS)
  writeStored(SHARED_SETTINGS_STORAGE_KEY, shared)
  if (sharedChanged) await postShared(shared)
}
