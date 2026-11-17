import { rename, unlink } from 'node:fs/promises'
import { exists } from '../cache.ts'
import { run, type RunResult } from '../run.ts'
import { MediaError } from './errors.ts'

/** How far along an ffmpeg run is: reported as 0–1 of `duration` written */
export interface FfmpegProgress {
  /** Seconds the output will last */
  duration: number
  onProgress: (fraction: number) => void
}

/** ffmpeg arguments that make it write its progress to stdout (put before the rest) */
export const PROGRESS_ARGS = ['-progress', 'pipe:1', '-nostats']

/**
 * Turns ffmpeg's `-progress pipe:1` output (key=value lines, each block ending
 * with progress=continue|end) into 0–1 fractions of `duration`. Feed it the
 * stdout chunks.
 */
export function progressReader(duration: number, onProgress: (fraction: number) => void) {
  let buffer = ''
  let time = 0
  return (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      const [key, value = ''] = line.split('=', 2)
      if (key === 'out_time_us') {
        const us = Number(value)
        if (Number.isFinite(us) && us > 0) time = us / 1_000_000
      } else if (key === 'progress') {
        onProgress(value === 'end' ? 1 : duration > 0 ? Math.min(1, time / duration) : 0)
      }
    }
  }
}

/**
 * Runs ffmpeg; a missing ffmpeg becomes a MediaError. If `signal` aborts,
 * ffmpeg is killed and this rejects with the signal's reason. With
 * `progress`, its onProgress is called as the output is written.
 */
export async function ffmpeg(
  args: string[],
  signal?: AbortSignal,
  progress?: FfmpegProgress,
): Promise<RunResult> {
  try {
    if (!progress) return await run('ffmpeg', args, signal)
    return await run(
      'ffmpeg',
      [...PROGRESS_ARGS, ...args],
      signal,
      progressReader(progress.duration, progress.onProgress),
    )
  } catch (e) {
    if (signal?.aborted) throw signal.reason
    throw new MediaError('spawn', `could not run ffmpeg: ${String(e)}`)
  }
}

/**
 * Runs ffmpeg writing to `tmp`, then moves the result to `out`, so a
 * half-written file is never served. Stopped by `signal` like `ffmpeg`; the
 * half-written `tmp` is deleted then.
 */
export async function ffmpegToFile(
  args: string[],
  tmp: string,
  out: string,
  signal?: AbortSignal,
  progress?: FfmpegProgress,
): Promise<void> {
  let result: RunResult
  try {
    result = await ffmpeg(args, signal, progress)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  if (result.code === 0 && (await exists(tmp))) {
    await rename(tmp, out)
    return
  }
  throw new MediaError('failed', result.stderr)
}
