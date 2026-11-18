// The edit dialog's trimmed / cropped copies, made in the background by the
// compress queue (server/compressQueue.ts) on the same lines as the
// compressions: videos one after another (an edit waits for the encode
// before it, so two never run at once), photos on their own line beside them.
//
// - videos: trimmed and/or cropped (./edit.ts)
// - JPEGs: cropped losslessly (./cropJpeg.ts)
// - PNGs, WebPs: cropped (./cropImage.ts)

import path from 'node:path'
import { isVideoName } from '../listing.ts'
import { onVideoLine, type CompressHooks } from './compress.ts'
import { onImageLine } from './compressImage.ts'
import { cropImage, isCroppableImageName } from './cropImage.ts'
import { cropJpeg, isJpegName } from './cropJpeg.ts'
import { EditError, editVideo, type EditResult, type HoldCopy, type VideoEdit } from './edit.ts'

/** True for the files an edited copy can be made of */
export function isEditableName(name: string): boolean {
  return isVideoName(name) || isJpegName(name) || isCroppableImageName(name)
}

/**
 * Saves the edited copy of `file` (a real path inside the shared folder),
 * waiting for its turn on its line. Photos only use the crop of `edit`
 */
export function editMedia(
  file: string,
  edit: VideoEdit,
  hooks: CompressHooks,
  hold?: HoldCopy,
): Promise<EditResult> {
  const name = path.basename(file)
  const crop = { x: edit.x, y: edit.y, w: edit.w, h: edit.h }
  if (isVideoName(name)) {
    return onVideoLine(hooks, () => editVideo(file, edit, hooks.signal, hooks.onProgress, hold))
  }
  if (isJpegName(name)) return onImageLine(hooks, () => cropJpeg(file, crop, hooks.signal, hold))
  if (isCroppableImageName(name)) {
    return onImageLine(hooks, () => cropImage(file, crop, hooks.signal, hold))
  }
  return Promise.reject(new EditError('Only videos and photos can be edited'))
}
