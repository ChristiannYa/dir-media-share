import path from 'node:path'
import { sendJson, type Handler } from '../http.ts'
import { SHARE_ROOT } from '../paths.ts'

/** GET /api/info : name of the shared folder */
export const info: Handler = async (_req, res) => {
  sendJson(res, { folder_name: path.basename(SHARE_ROOT) })
}
