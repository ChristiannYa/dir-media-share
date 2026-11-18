// Request handling of the backend, shared by both ways of running it:
// - inside Vite (server/vitePlugin.ts): `vite` / `npm run dev`, the normal way
// - on its own (server/main.ts): serves the built frontend from dist/

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAuthorized, password, rejectUnauthorized } from './auth.ts'
import { generatedCacheControl } from './cacheControl.ts'
import { startCachePruning } from './cachePrune.ts'
import { PREVIEW_DIR } from './consts/previews.ts'
import {
  ROUTE_APP_MODE_FRAME,
  ROUTE_APP_MODE_HISTORY,
  ROUTE_APP_MODE_HISTORY_DELETE,
  ROUTE_APP_MODE_HISTORY_IMAGE,
  ROUTE_APP_MODE_IMAGE,
  ROUTE_APP_MODE_IMAGE_REMOVE,
  ROUTE_APP_MODE_IMAGE_RESTORE,
  ROUTE_APP_MODE_IMAGES,
  ROUTE_BROWSE,
  ROUTE_CANCEL_JOB,
  ROUTE_CLEAR_CACHE,
  ROUTE_COMPRESS_CANCEL,
  ROUTE_COMPRESS_CLEAR,
  ROUTE_COMPRESS_DISCARD,
  ROUTE_COMPRESS_EDIT,
  ROUTE_COMPRESS_JOBS,
  ROUTE_COMPRESS_QUEUE,
  ROUTE_COMPRESS_SEEN,
  ROUTE_CREATE_FOLDER,
  ROUTE_DISCARD_UPLOAD,
  ROUTE_FAVORITE,
  ROUTE_FILES,
  ROUTE_FIX_TS,
  ROUTE_FOLDER_PREVIEW,
  ROUTE_FOLDER_THUMB,
  ROUTE_FOLDERS,
  ROUTE_HEATMAP,
  ROUTE_INFO,
  ROUTE_JOB_EVENTS,
  ROUTE_LOGIN,
  ROUTE_LOGOUT,
  ROUTE_HEARTED,
  ROUTE_MOST_PLAYED,
  ROUTE_MOVE_FILE,
  ROUTE_NUMBER_FILES,
  ROUTE_PREVIEW,
  ROUTE_PREVIEWS,
  ROUTE_RENAME,
  ROUTE_SESSION,
  ROUTE_SET_PLAYS,
  ROUTE_SETTINGS,
  ROUTE_SHARED_SETTINGS,
  ROUTE_SHUTDOWN,
  ROUTE_STORYBOARD,
  ROUTE_STORYBOARDS,
  ROUTE_THUMB,
  ROUTE_TRASH_FILE,
  ROUTE_UPLOAD_FILE,
  ROUTE_VIEWED,
} from './consts/routes.ts'
import { PASSWORD_ENV } from './consts/server.ts'
import { STORYBOARD_DIR } from './consts/storyboards.ts'
import {
  appModeHistory,
  appModeHistoryImage,
  appModeImage,
  appModeImages,
  deleteAppModeHistoryImage,
  removeAppModeImage,
  restoreAppModeImage,
  saveAppModeFrame,
  uploadAppModeImage,
} from './handlers/appModeImage.ts'
import { browse } from './handlers/browse.ts'
import { clearCache } from './handlers/clearCache.ts'
import {
  cancelCompressJobs,
  clearCompressJobs,
  compressedSeen,
  discardCompressJobHandler,
  listCompressJobs,
  queueCompress,
  queueEdit,
} from './handlers/compress.ts'
import {
  createFolder,
  discardUpload,
  favoriteFile,
  folders,
  moveFile,
  numberFiles,
  renameEntry,
  setPlays,
  trashFile,
  uploadFile,
  viewedFile,
} from './handlers/files.ts'
import { folderPreviewHandler } from './handlers/folderPreview.ts'
import { getHeatmap, postHeatmap } from './handlers/heatmap.ts'
import { info } from './handlers/info.ts'
import { cancelJob, jobEvents } from './handlers/jobEvents.ts'
import { login, logout, session } from './handlers/login.ts'
import { hearted } from './handlers/hearted.ts'
import { mostPlayed } from './handlers/mostPlayed.ts'
import { previewHandler } from './handlers/preview.ts'
import {
  getSettings,
  getSharedSettings,
  saveSettings,
  saveSharedSettingsHandler,
} from './handlers/settings.ts'
import { shutdown } from './handlers/shutdown.ts'
import { storyboardHandler } from './handlers/storyboard.ts'
import { folderThumb, thumb } from './handlers/thumb.ts'
import { fixTsFile } from './handlers/tsFix.ts'
import { sendStatus, serveStatic, type Handler } from './http.ts'
import { startIdleShutdown, trackActivity } from './idle.ts'
import { SHARE_ROOT } from './paths.ts'

// keeps the cache of stills, previews and storyboards under its size limit
startCachePruning()
// stops the server after a while without activity (Settings → Server → Shutdown)
startIdleShutdown()

/** True if the passcode is set (digits only); without it every request is refused */
export function hasPassword(): boolean {
  return password !== null
}

/** API routes: path → a handler per allowed method (GET also answers HEAD) */
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {
  [ROUTE_BROWSE]: { GET: browse },
  [ROUTE_INFO]: { GET: info },
  [ROUTE_THUMB]: { GET: thumb },
  [ROUTE_PREVIEW]: { GET: previewHandler },
  [ROUTE_FOLDER_PREVIEW]: { GET: folderPreviewHandler },
  [ROUTE_FOLDER_THUMB]: { GET: folderThumb },
  [ROUTE_JOB_EVENTS]: { GET: jobEvents },
  [ROUTE_CANCEL_JOB]: { POST: cancelJob },
  [ROUTE_STORYBOARD]: { GET: storyboardHandler },
  [ROUTE_CLEAR_CACHE]: { POST: clearCache },
  [ROUTE_FOLDERS]: { GET: folders },
  [ROUTE_TRASH_FILE]: { POST: trashFile },
  [ROUTE_MOVE_FILE]: { POST: moveFile },
  [ROUTE_UPLOAD_FILE]: { POST: uploadFile },
  [ROUTE_CREATE_FOLDER]: { POST: createFolder },
  [ROUTE_RENAME]: { POST: renameEntry },
  [ROUTE_NUMBER_FILES]: { POST: numberFiles },
  [ROUTE_FAVORITE]: { POST: favoriteFile },
  [ROUTE_VIEWED]: { POST: viewedFile },
  [ROUTE_MOST_PLAYED]: { GET: mostPlayed },
  [ROUTE_HEARTED]: { GET: hearted },
  [ROUTE_SET_PLAYS]: { POST: setPlays },
  [ROUTE_HEATMAP]: { GET: getHeatmap, POST: postHeatmap },
  [ROUTE_DISCARD_UPLOAD]: { POST: discardUpload },
  [ROUTE_COMPRESS_JOBS]: { GET: listCompressJobs },
  [ROUTE_COMPRESS_QUEUE]: { POST: queueCompress },
  [ROUTE_COMPRESS_EDIT]: { POST: queueEdit },
  [ROUTE_COMPRESS_CANCEL]: { POST: cancelCompressJobs },
  [ROUTE_COMPRESS_DISCARD]: { POST: discardCompressJobHandler },
  [ROUTE_COMPRESS_CLEAR]: { POST: clearCompressJobs },
  [ROUTE_COMPRESS_SEEN]: { POST: compressedSeen },
  [ROUTE_FIX_TS]: { POST: fixTsFile },
  [ROUTE_SETTINGS]: { GET: getSettings, POST: saveSettings },
  [ROUTE_SHARED_SETTINGS]: { GET: getSharedSettings, POST: saveSharedSettingsHandler },
  [ROUTE_SHUTDOWN]: { GET: shutdown },
  [ROUTE_LOGIN]: { POST: login },
  [ROUTE_SESSION]: { GET: session },
  [ROUTE_LOGOUT]: { POST: logout },
  [ROUTE_APP_MODE_IMAGE]: { GET: appModeImage, POST: uploadAppModeImage },
  [ROUTE_APP_MODE_IMAGES]: { GET: appModeImages },
  [ROUTE_APP_MODE_FRAME]: { POST: saveAppModeFrame },
  [ROUTE_APP_MODE_IMAGE_REMOVE]: { POST: removeAppModeImage },
  [ROUTE_APP_MODE_IMAGE_RESTORE]: { POST: restoreAppModeImage },
  [ROUTE_APP_MODE_HISTORY]: { GET: appModeHistory },
  [ROUTE_APP_MODE_HISTORY_IMAGE]: { GET: appModeHistoryImage },
  [ROUTE_APP_MODE_HISTORY_DELETE]: { POST: deleteAppModeHistoryImage },
}

/**
 * Routes open without logging in: the lock screen needs them, and logging out
 * must work even with an expired cookie
 */
const PUBLIC_ROUTES = new Set([ROUTE_LOGIN, ROUTE_SESSION, ROUTE_LOGOUT])

/** A static folder: files under `prefix` in the URL come from `root` on disk */
interface Mount {
  prefix: string
  root: string
  /**
   * How long the browser may keep these files (asked per response, so a
   * settings change applies right away); none = it checks with the server
   */
  cacheControl?: () => string
}

const mounts: Mount[] = [
  { prefix: ROUTE_PREVIEWS, root: PREVIEW_DIR, cacheControl: generatedCacheControl },
  { prefix: ROUTE_STORYBOARDS, root: STORYBOARD_DIR, cacheControl: generatedCacheControl },
  // originals can be edited under the same name, so the browser always checks
  { prefix: ROUTE_FILES, root: SHARE_ROOT },
]

function mountFor(pathname: string): Mount | undefined {
  return mounts.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** True for paths this backend answers (the rest is the frontend) */
export function isServerPath(pathname: string): boolean {
  return Object.hasOwn(routes, pathname) || mountFor(pathname) !== undefined
}

/** Checks the login; answers the request itself (401 / 500) and returns false if it fails */
export function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!password) {
    console.error(
      `❌ Set ${PASSWORD_ENV} (digits only) before starting, every request is refused until then`,
    )
    sendStatus(res, 500)
    return false
  }
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (PUBLIC_ROUTES.has(pathname)) return true
  if (!isAuthorized(req)) {
    rejectUnauthorized(res)
    return false
  }
  return true
}

/** Answers an API route or a file from one of the static folders */
export async function handleServerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  trackActivity(url.pathname, res)
  const route = routes[url.pathname]
  if (route) {
    const handler =
      req.method === 'POST' ? route.POST : req.method === 'GET' || req.method === 'HEAD' ? route.GET : undefined
    if (!handler) return sendStatus(res, 405)
    return handler(req, res, url)
  }
  const mount = mountFor(url.pathname)
  if (mount) {
    const { prefix, root, cacheControl } = mount
    return serveStatic(req, res, root, url.pathname.slice(prefix.length), cacheControl?.())
  }
  sendStatus(res, 404)
}
