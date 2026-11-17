// Moving files to the desktop's trash (freedesktop.org Trash spec), so the
// file manager can restore them.
//
// A trashed file goes to TRASH_DIR/files/<name>, next to a small
// TRASH_DIR/info/<name>.trashinfo that records where it came from and when.

import { constants } from 'node:fs'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exists } from './cache.ts'
import { TRASH_DIR } from './consts/trash.ts'

const FILES_DIR = path.join(TRASH_DIR, 'files')
const INFO_DIR = path.join(TRASH_DIR, 'info')

/** Local time as YYYY-MM-DDThh:mm:ss, the format the spec asks for */
function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function trashInfo(original: string, date: Date): string {
  // the original path is stored URL-encoded, keeping the slashes
  const encoded = original.split('/').map(encodeURIComponent).join('/')
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${localTimestamp(date)}\n`
}

/**
 * Picks a name not used in the trash yet ("clip.mp4", "clip.2.mp4", …) and
 * claims it by creating its .trashinfo; creating it exclusively makes sure
 * two deletions can't pick the same name. Returns the name.
 */
async function claimName(name: string, info: string): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${base}.${i}${ext}`
    const infoFile = path.join(INFO_DIR, `${candidate}.trashinfo`)
    try {
      await writeFile(infoFile, info, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    // a leftover file without its info: don't overwrite it, try the next name
    if (await exists(path.join(FILES_DIR, candidate))) {
      await unlink(infoFile)
      continue
    }
    return candidate
  }
}

/** Moves `file` (absolute path) to the trash */
export async function moveToTrash(file: string): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true })
  await mkdir(INFO_DIR, { recursive: true })

  const name = await claimName(path.basename(file), trashInfo(file, new Date()))
  const target = path.join(FILES_DIR, name)
  try {
    await rename(file, target)
  } catch (e) {
    // rename can't cross drives (e.g. a folder on another disk): copy, then remove
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(file, target, constants.COPYFILE_EXCL)
      await unlink(file)
      return
    }
    await unlink(path.join(INFO_DIR, `${name}.trashinfo`)).catch(() => {})
    throw e
  }
}
