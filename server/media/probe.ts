// Reading video metadata with ffprobe.

import { stat } from 'node:fs/promises'
import { MPEGTS_FORMAT } from '../consts/fileTypes.ts'
import { MAX_PLAUSIBLE_FPS } from '../consts/probe.ts'
import { run } from '../run.ts'

export interface VideoInfo {
  /** Seconds */
  duration: number
  /** ffprobe container name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "mpegts" */
  format: string
  /**
   * Size in stored pixels (already swapped for videos recorded rotated); what
   * ffmpeg's filters (e.g. crop) work in
   */
  width: number | null
  height: number | null
  /**
   * Size it plays at: like width / height, but with non-square pixels applied
   * the way browsers do it, stretching one side (a 1080×1080 video with 9:16
   * pixels plays as 1080×1920)
   */
  displayWidth: number | null
  displayHeight: number | null
  /** Frames per second of the video stream */
  fps: number | null
}

/** The parts of ffprobe's JSON output used here */
interface ProbeOutput {
  format?: { duration?: string; format_name?: string }
  streams?: Array<{
    width?: number
    height?: number
    /** "9:16" on videos stored with non-square pixels (stretched when played) */
    sample_aspect_ratio?: string
    avg_frame_rate?: string
    r_frame_rate?: string
    side_data_list?: Array<{ rotation?: number }>
    tags?: { rotate?: string }
  }>
}

/** MPEG-TS can't be played by browsers, even when named .mp4 */
export function isMpegts(info: VideoInfo): boolean {
  return info.format.includes(MPEGTS_FORMAT)
}

/** Parses ffprobe's "30000/1001" style rates; null if missing or implausible */
function parseRate(value: string | undefined): number | null {
  const [num, den] = (value ?? '').split('/').map(Number)
  if (num === undefined || den === undefined) return null
  const rate = num / den
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_PLAUSIBLE_FPS ? rate : null
}

export async function videoInfo(file: string): Promise<VideoInfo | null> {
  let json: ProbeOutput
  try {
    const result = await run('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-select_streams',
      'v:0',
      file,
    ])
    json = JSON.parse(result.stdout) as ProbeOutput
  } catch {
    return null
  }

  const duration = Number(json.format?.duration)
  if (json.format?.duration === undefined || !Number.isFinite(duration)) return null

  const stream = json.streams?.[0]
  let width = stream?.width ?? null
  let height = stream?.height ?? null
  // non-square pixels ("9:16": each pixel shown at 9/16 of its width):
  // stretch one side, as browsers do, so no detail is counted away
  const [sarNum, sarDen] = (stream?.sample_aspect_ratio ?? '').split(':').map(Number)
  const sar = sarNum && sarDen ? sarNum / sarDen : 1
  let displayWidth = width && sar > 1 ? Math.round(width * sar) : width
  let displayHeight = height && sar < 1 ? Math.round(height / sar) : height
  // phone videos are often stored sideways with a rotation flag
  const rotation =
    stream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
    Number(stream?.tags?.rotate ?? 0)
  if ((((rotation % 180) + 180) % 180) === 90) {
    ;[width, height] = [height, width]
    ;[displayWidth, displayHeight] = [displayHeight, displayWidth]
  }

  // the average rate is the real one; r_frame_rate can be a timebase artifact
  const fps = parseRate(stream?.avg_frame_rate) ?? parseRate(stream?.r_frame_rate)

  return {
    duration,
    format: json.format?.format_name ?? '',
    width,
    height,
    displayWidth,
    displayHeight,
    fps,
  }
}

/**
 * videoInfo results by path and modification time: a preview clip is rebuilt
 * under the same name when its video or the settings change, and a video
 * edited in place gets a new time, so neither is answered from an old probe
 */
const infoCache = new Map<string, VideoInfo | null>()

/**
 * videoInfo, probed once per version of the file (for what's asked about on
 * every preview request: the finished clip and its video)
 */
export async function cachedVideoInfo(file: string): Promise<VideoInfo | null> {
  const key = `${file}@${(await stat(file).catch(() => null))?.mtimeMs ?? 0}`
  if (infoCache.has(key)) return infoCache.get(key) ?? null
  const info = await videoInfo(file)
  if (infoCache.size > 5000) infoCache.clear() // previews come and go; don't grow forever
  infoCache.set(key, info)
  return info
}

/**
 * Frame rate of a finished preview clip, so each device can pick a playback
 * speed that fits its screen's refresh rate. Probed once per build of a clip.
 */
export async function clipFps(clip: string): Promise<number | null> {
  return (await cachedVideoInfo(clip))?.fps ?? null
}

export async function videoDuration(file: string): Promise<number | null> {
  return (await videoInfo(file))?.duration ?? null
}
