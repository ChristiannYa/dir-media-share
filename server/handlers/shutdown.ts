import type { Handler } from '../http.ts'
import { shutdownNow } from '../shutdown.ts'

/** GET /api/shutdown : stops vite (dev mode) and this server */
export const shutdown: Handler = async (_req, res) => {
  res.end()
  await shutdownNow('shutdown button')
}
