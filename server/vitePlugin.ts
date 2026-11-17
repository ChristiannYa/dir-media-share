// Runs the backend inside Vite's dev server: one process, one port, and
// started together with the client by `vite` / `npm run dev`.
//
// The backend is loaded through Vite's module loader, which reloads a server
// file as soon as it's saved: the next request already uses the new code, no
// restart needed (just like the frontend's hot reload).

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { ROUTE_FILES, ROUTE_PREVIEWS, ROUTE_STORYBOARDS } from './consts/routes.ts'
import { PASSWORD_ENV } from './consts/server.ts'
import { SHARE_ROOT } from './paths.ts'

/** URL prefixes the backend answers; everything else goes to Vite (the client) */
const SERVER_PREFIXES = ['/api/', `${ROUTE_FILES}/`, `${ROUTE_PREVIEWS}/`, `${ROUTE_STORYBOARDS}/`]

/** What server/app.ts exports (loaded at request time, so typed by hand here) */
interface ServerApp {
  isServerPath(pathname: string): boolean
  checkAuth(req: IncomingMessage, res: ServerResponse): boolean
  handleServerRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>
}

export function medServer(): Plugin {
  return {
    name: 'med-server',
    configureServer(server) {
      const { logger } = server.config
      // Node cuts requests off after 5 minutes by default, which would break
      // the upload of a big video over a slow connection
      if (server.httpServer && 'requestTimeout' in server.httpServer) {
        server.httpServer.requestTimeout = 0
      }
      server.httpServer?.once('listening', () => {
        logger.info(`  ➜  Sharing: ${SHARE_ROOT}`)
        if (!/^\d+$/.test(process.env[PASSWORD_ENV] ?? '')) {
          logger.error(`  ❌ ${PASSWORD_ENV} is not set (digits only): every request will be refused`)
        }
        // load the backend now rather than on the first request, so its idle
        // shutdown (server/idle.ts) counts from the start even if nobody visits
        server.ssrLoadModule('/server/app.ts').catch((error: unknown) => {
          logger.error(`[med-server] ${String(error)}`)
        })
      })

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!SERVER_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return next()

        server
          .ssrLoadModule('/server/app.ts')
          .then(async (module) => {
            const app = module as unknown as ServerApp
            if (!app.isServerPath(url.pathname)) return next()
            if (!app.checkAuth(req, res)) return
            await app.handleServerRequest(req, res, url)
          })
          .catch((error: unknown) => {
            // e.g. a typo in a server file that was just saved
            logger.error(`[med-server] ${String(error)}`)
            if (!res.headersSent) {
              res.statusCode = 500
              res.end()
            } else {
              res.destroy()
            }
          })
      })
    },
  }
}
