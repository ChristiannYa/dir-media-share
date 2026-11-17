export type MediaErrorKind =
  /** ffmpeg / ffprobe could not be started */
  | 'spawn'
  /** The video's duration (or size) could not be read */
  | 'no-duration'
  /** ffmpeg ran but produced nothing; the message holds what it printed */
  | 'failed'

export class MediaError extends Error {
  readonly kind: MediaErrorKind

  constructor(kind: MediaErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}
