// Where deleted files go.

import os from 'node:os'
import path from 'node:path'

/**
 * The desktop's trash, as defined by the freedesktop.org Trash spec (the one
 * Dolphin, Nautilus and most Linux file managers show): $XDG_DATA_HOME/Trash,
 * usually ~/.local/share/Trash. Files sent there can be restored or emptied
 * from the file manager as usual.
 */
export const TRASH_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'Trash',
)
