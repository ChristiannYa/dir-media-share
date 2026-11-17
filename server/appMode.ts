// App mode of the device making a request (switched in the app's top bar,
// src/appMode.ts), from its APP_MODE_COOKIE:
// - goon (no cookie, or anything else): video data is recorded (plays, "last
//   viewed", the most watched parts) and sent with the listings
// - dev: none of it is recorded, and none is sent: listings come without
//   plays or "last viewed", the "Most played" sections and heatmaps are empty.
//   What was recorded before stays saved, for goon mode.

import type { IncomingMessage } from 'node:http'
import { readCookie } from './auth.ts'
import { APP_MODE_COOKIE } from './consts/server.ts'

/** True if the request comes from a device in dev mode */
export function isDevMode(req: IncomingMessage): boolean {
  return readCookie(req, APP_MODE_COOKIE) === 'dev'
}
