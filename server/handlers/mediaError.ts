import type { ServerResponse } from 'node:http'
import { sendStatus } from '../http.ts'
import { MediaError } from '../media/errors.ts'

/** Logs a failed ffmpeg job and answers with a fitting status code */
export function mediaError(res: ServerResponse, job: string, file: string, error: unknown) {
  console.error(`${job} failed for ${file}: ${error instanceof Error ? error.message : error}`)
  const status = error instanceof MediaError && error.kind !== 'spawn' ? 422 : 500
  sendStatus(res, status)
}
