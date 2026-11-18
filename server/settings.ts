// Server settings: the tunable values of server/consts/, changeable from the
// app's Settings popup. The constants stay the defaults; changes are saved to
// SETTINGS_FILE (config/server-settings.json in this project) and apply to
// every device.
//
// Previews, stills and storyboards put these values in their cache names, so
// a change makes new ones on the next request; old ones are never reused.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CACHE_MAX_AGE_DAYS, CACHE_MAX_GB } from './consts/caching.ts'
import {
  FOLDER_PREVIEW_ITEMS,
  FOLDER_PREVIEW_SLICES_PER_VIDEO,
  FOLDER_PREVIEW_VARIANTS,
} from './consts/folderPreviews.ts'
import {
  PREVIEW_CLIPS,
  PREVIEW_CRF,
  PREVIEW_MAX_JOBS,
  PREVIEW_PRESET,
  PREVIEW_SECS,
  PREVIEW_WIDTH,
} from './consts/previews.ts'
import { PROBE_MAX_JOBS } from './consts/probe.ts'
import { SCALE_FLAGS } from './consts/scaling.ts'
import { LEGACY_SETTINGS_FILE, LOCK_AFTER_MINUTES, SETTINGS_FILE } from './consts/server.ts'
import { IDLE_SHUTDOWN_MINUTES } from './consts/shutdown.ts'
import {
  STORYBOARD_COLUMNS,
  STORYBOARD_MAX_JOBS,
  STORYBOARD_MAX_TILES,
  STORYBOARD_MIN_INTERVAL,
  STORYBOARD_QUALITY,
  STORYBOARD_TILE_WIDTH,
} from './consts/storyboards.ts'
import { THUMB_QUALITY, THUMB_SAMPLE_FRAMES, THUMB_WIDTH } from './consts/thumbnails.ts'

export const SERVER_SETTING_DEFAULTS = {
  previewClips: PREVIEW_CLIPS,
  previewSecs: PREVIEW_SECS,
  previewWidth: PREVIEW_WIDTH,
  previewCrf: PREVIEW_CRF,
  previewPreset: PREVIEW_PRESET as string,
  previewMaxJobs: PREVIEW_MAX_JOBS,
  folderPreviewItems: FOLDER_PREVIEW_ITEMS,
  folderPreviewSlicesPerVideo: FOLDER_PREVIEW_SLICES_PER_VIDEO,
  folderPreviewVariants: FOLDER_PREVIEW_VARIANTS,
  thumbWidth: THUMB_WIDTH,
  thumbQuality: THUMB_QUALITY,
  thumbSampleFrames: THUMB_SAMPLE_FRAMES,
  storyboardTileWidth: STORYBOARD_TILE_WIDTH,
  storyboardColumns: STORYBOARD_COLUMNS,
  storyboardMaxTiles: STORYBOARD_MAX_TILES,
  storyboardMinInterval: STORYBOARD_MIN_INTERVAL,
  storyboardQuality: STORYBOARD_QUALITY,
  storyboardMaxJobs: STORYBOARD_MAX_JOBS,
  scaleFlags: SCALE_FLAGS as string,
  probeMaxJobs: PROBE_MAX_JOBS,
  cacheMaxAgeDays: CACHE_MAX_AGE_DAYS,
  cacheMaxGB: CACHE_MAX_GB,
  lockAfterMinutes: LOCK_AFTER_MINUTES,
  idleShutdownMinutes: IDLE_SHUTDOWN_MINUTES,
}

export type ServerSettings = typeof SERVER_SETTING_DEFAULTS
export type ServerSettingKey = keyof ServerSettings

/** Same shape as the client's SettingField (src/settings.ts), sent to it as JSON */
export type ServerSettingField = { key: ServerSettingKey; label: string; help: string } & (
  | { type: 'number'; min: number; max: number; step: number; unit?: string }
  | { type: 'select'; options: string[] }
)

const PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]
const SCALERS = ['fast_bilinear', 'bilinear', 'bicubic', 'neighbor', 'area', 'spline', 'lanczos']

/** Same shape as the client's FieldGroup (src/settings.ts): subsections split it into collapsible parts */
export const SERVER_SETTING_GROUPS: Array<{
  title: string
  fields: ServerSettingField[]
  subsections?: Array<{ title: string; keys: ServerSettingKey[] }>
}> = [
  {
    title: 'Previews',
    subsections: [
      {
        title: 'Clips',
        keys: ['previewClips', 'previewSecs', 'previewWidth', 'previewCrf', 'previewPreset'],
      },
      {
        title: 'Folder previews',
        keys: ['folderPreviewItems', 'folderPreviewSlicesPerVideo', 'folderPreviewVariants'],
      },
      { title: 'Encoding', keys: ['previewMaxJobs'] },
    ],
    fields: [
      {
        key: 'previewClips',
        label: 'Slices',
        help: 'Slices spread across each video; more makes a longer loop that shows more of it',
        type: 'number',
        min: 1,
        max: 30,
        step: 1,
      },
      {
        key: 'previewSecs',
        label: 'Slice length',
        help: 'Seconds of the original video in each slice',
        type: 'number',
        min: 0.5,
        max: 15,
        step: 0.5,
        unit: 's',
      },
      {
        key: 'previewWidth',
        label: 'Width',
        help: 'Sharper but slower to encode and bigger. Phones need ~3× the card width; 720 is ~2.25× the cost of 480',
        type: 'number',
        min: 160,
        max: 1920,
        step: 2,
        unit: 'px',
      },
      {
        key: 'previewCrf',
        label: 'Quality (CRF)',
        help: 'Lower is better and bigger. ~18 looks near-lossless, 23 is x264\'s default, 28 is visibly soft',
        type: 'number',
        min: 0,
        max: 51,
        step: 1,
      },
      {
        key: 'previewPreset',
        label: 'Encoder preset',
        help: 'Slower presets make smaller files at the same quality but take longer to encode',
        type: 'select',
        options: PRESETS,
      },
      {
        key: 'folderPreviewItems',
        label: 'Folder preview items',
        help: 'Max slices (or images) in a folder\'s preview, from a random pick of the folder\'s files',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
      },
      {
        key: 'folderPreviewSlicesPerVideo',
        label: 'Folder preview slices per video',
        help: 'With few videos, the preview goes round them taking several slices of each (from different parts), up to this many per video',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
      },
      {
        key: 'folderPreviewVariants',
        label: 'Folder preview variants',
        help: 'Different random previews kept per folder; each time a folder appears it shows one of them. Each is encoded the first time it\'s shown',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
      },
      {
        key: 'previewMaxJobs',
        label: 'Encodes at once',
        help: 'Each already uses several CPU cores; raise only if the CPU isn\'t fully busy while previews build',
        type: 'number',
        min: 1,
        max: 32,
        step: 1,
      },
    ],
  },
  {
    title: 'Stills',
    fields: [
      {
        key: 'thumbWidth',
        label: 'Width',
        help: 'Width of the still on each video card',
        type: 'number',
        min: 160,
        max: 1920,
        step: 2,
        unit: 'px',
      },
      {
        key: 'thumbQuality',
        label: 'JPEG quality',
        help: '2 is best and biggest, 31 worst and smallest',
        type: 'number',
        min: 2,
        max: 31,
        step: 1,
      },
      {
        key: 'thumbSampleFrames',
        label: 'Frames compared',
        help: 'Frames looked at to pick a representative one (skips black frames). Higher picks better but is slower',
        type: 'number',
        min: 1,
        max: 1000,
        step: 1,
      },
    ],
  },
  {
    title: 'Slider storyboards',
    subsections: [
      {
        title: 'Layout',
        keys: [
          'storyboardTileWidth',
          'storyboardColumns',
          'storyboardMaxTiles',
          'storyboardMinInterval',
        ],
      },
      { title: 'Quality & speed', keys: ['storyboardQuality', 'storyboardMaxJobs'] },
    ],
    fields: [
      {
        key: 'storyboardTileWidth',
        label: 'Tile width',
        help: 'Width of each small frame in the grid',
        type: 'number',
        min: 40,
        max: 480,
        step: 2,
        unit: 'px',
      },
      {
        key: 'storyboardColumns',
        label: 'Columns',
        help: 'Tiles per row of the grid image',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
      },
      {
        key: 'storyboardMaxTiles',
        label: 'Max tiles',
        help: 'Long videos space tiles out to stay under this. Higher is more precise but a bigger image',
        type: 'number',
        min: 10,
        max: 1000,
        step: 1,
      },
      {
        key: 'storyboardMinInterval',
        label: 'Min spacing',
        help: 'Tiles are never closer than this (matters for short videos)',
        type: 'number',
        min: 0.5,
        max: 60,
        step: 0.5,
        unit: 's',
      },
      {
        key: 'storyboardQuality',
        label: 'JPEG quality',
        help: '2 is best and biggest, 31 worst and smallest',
        type: 'number',
        min: 2,
        max: 31,
        step: 1,
      },
      {
        key: 'storyboardMaxJobs',
        label: 'Builds at once',
        help: 'Each reads its whole video. 2–3 is fine on an SSD; keep 1 on a hard drive',
        type: 'number',
        min: 1,
        max: 8,
        step: 1,
      },
    ],
  },
  {
    title: 'Caching',
    fields: [
      {
        key: 'cacheMaxGB',
        label: 'Cache size limit',
        help: 'Most disk space stills, previews and storyboards may use (in ~/.cache/med). Above it, the ones used longest ago are deleted, and built again if needed. Checked every minute',
        type: 'number',
        min: 1,
        max: 2000,
        step: 1,
        unit: 'GB',
      },
      {
        key: 'cacheMaxAgeDays',
        label: 'Browser cache',
        help: 'Days a browser reuses stills, previews and storyboards without asking the server again (0 = always asks: unchanged previews and storyboards aren\'t re-sent, stills are). Applies to files loaded from now on',
        type: 'number',
        min: 0,
        max: 365,
        step: 1,
        unit: 'days',
      },
    ],
  },
  {
    title: 'Other',
    fields: [
      {
        key: 'scaleFlags',
        label: 'Scaling',
        help: 'How ffmpeg shrinks stills and previews. lanczos keeps the most detail',
        type: 'select',
        options: SCALERS,
      },
      {
        key: 'probeMaxJobs',
        label: 'Probes at once',
        help: 'Videos read in parallel (duration, format) when listing a folder',
        type: 'number',
        min: 1,
        max: 64,
        step: 1,
      },
    ],
  },
  {
    title: 'Lock screen',
    fields: [
      {
        key: 'lockAfterMinutes',
        label: 'Lock after',
        help: 'Minutes from entering the passcode until the app locks and asks for it again; the time left shows in the top bar and the viewer. Enforced by the server, so reloading doesn\'t reset it. 0 = never (stays unlocked for 30 days). Changing it locks this device right away, so the new time starts with the next unlock; other devices keep their current time until they unlock again',
        type: 'number',
        min: 0,
        max: 1440,
        step: 1,
        unit: 'min',
      },
    ],
  },
  {
    title: 'Shutdown',
    fields: [
      {
        key: 'idleShutdownMinutes',
        label: 'Shut down when idle',
        help: 'Minutes without any activity after which the server stops by itself, like the shutdown button. Activity is anything any device asks of it (opening folders, loading stills and previews, playing a video…); something still running, like an upload, counts the whole time, and while the compress queue has anything waiting or compressing the timer keeps extending itself, so it only starts counting once the last one is done. A tab just left open doesn\'t count. 0 = never',
        type: 'number',
        min: 0,
        max: 1440,
        step: 1,
        unit: 'min',
      },
    ],
  },
]

const FIELDS = SERVER_SETTING_GROUPS.flatMap((g) => g.fields)

/** Why `value` can't be used for `field`, or null if it's fine */
function problemOf(field: ServerSettingField, value: unknown): string | null {
  if (field.type === 'select') {
    return typeof value === 'string' && field.options.includes(value) ? null : 'Pick one of the options'
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number'
  if (value < field.min || value > field.max) return `Between ${field.min} and ${field.max}`
  if (field.step >= 1 && !Number.isInteger(value)) return 'Whole numbers only'
  return null
}

/** The saved settings in `file`, or null if there's no such file (or it's unreadable) */
function readSaved(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch {
    return null
  }
}

/** Saved values on top of the defaults; anything unknown or invalid is ignored */
function load(): ServerSettings {
  const result = { ...SERVER_SETTING_DEFAULTS }
  // the project's file; until it exists, the one older versions saved
  // (no file at all: defaults)
  const saved = readSaved(SETTINGS_FILE) ?? readSaved(LEGACY_SETTINGS_FILE) ?? {}
  for (const field of FIELDS) {
    const value = saved[field.key]
    if (value !== undefined && problemOf(field, value) === null) {
      ;(result as Record<ServerSettingKey, unknown>)[field.key] = value
    }
  }
  return result
}

/**
 * The current settings. Read them at the moment they're needed (not copied
 * into module constants), so a change applies to the next request.
 */
export const serverSettings: ServerSettings = load()

/**
 * Checks `input` (from the client) and, if every value is valid, applies and
 * saves it. Returns the problems by key, or null on success.
 */
export async function updateServerSettings(
  input: Record<string, unknown>,
): Promise<Record<string, string> | null> {
  const next = { ...serverSettings }
  const problems: Record<string, string> = {}
  for (const field of FIELDS) {
    if (!(field.key in input)) continue
    const value = input[field.key]
    const problem = problemOf(field, value)
    if (problem) problems[field.key] = problem
    else (next as Record<ServerSettingKey, unknown>)[field.key] = value
  }
  if (Object.keys(problems).length > 0) return problems

  const changed = Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => SERVER_SETTING_DEFAULTS[key as ServerSettingKey] !== value,
    ),
  )
  // write a temp file, then rename: a crash mid-write can't leave half a file
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true })
  const tmp = `${SETTINGS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(changed, null, 2) + '\n')
  await rename(tmp, SETTINGS_FILE)

  Object.assign(serverSettings, next)
  console.log('Server settings changed:', changed)
  return null
}
