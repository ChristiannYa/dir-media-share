// Runs the backend on its own, serving the built frontend (dist/) too.
// Not needed during development: `vite` / `npm run dev` already includes the
// backend (see server/vitePlugin.ts). Use this to run the built site:
//   npm run build && MED_PASSWORD=... npm run server

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { checkAuth, handleServerRequest, hasPassword, isServerPath } from './app.ts'
import { DIST_DIR, PASSWORD_ENV, PORT } from './consts/server.ts'
import { sendStatus, serveStatic } from './http.ts'
import { SHARE_ROOT } from './paths.ts'

if (!hasPassword()) {
  console.error(`❌ Set ${PASSWORD_ENV} first (digits only)`)
  process.exit(1)
}

/** Everything that isn't the backend is the built frontend */
const distRoot = path.resolve(import.meta.dirname, '..', DIST_DIR)

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (isServerPath(url.pathname)) {
    if (!checkAuth(req, res)) return
    return handleServerRequest(req, res, url)
  }
  // the built frontend holds nothing secret: it has to load to show the lock screen
  return serveStatic(req, res, distRoot, url.pathname)
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error)
    if (!res.headersSent) sendStatus(res, 500)
    else res.destroy()
  })
})

// Node cuts requests off after 5 minutes by default, which would break the
// upload of a big video over a slow connection
server.requestTimeout = 0

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`❌ Port ${PORT} already in use`)
  else console.error(error)
  process.exit(1)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sharing: ${SHARE_ROOT}`)
  console.log(`Listening on http://0.0.0.0:${PORT}`)
})
