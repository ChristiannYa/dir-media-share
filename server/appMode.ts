// App mode of the device making a request (switched in the app's top bar,
// src/appMode.ts), from its APP_MODE_COOKIE:
// - goon (no cookie, or anything else): video data is recorded (plays, "last
//   viewed", the most watched parts, hearts, opened compressed copies)
// - dev: for working on the app. Everything is shown just like in goon mode,
//   but nothing is recorded: views, heatmaps, hearts and "Compressed!"
//   banners stay as they were.

import type { IncomingMessage } from 'node:http'
import { readCookie } from './auth.ts'
import { APP_MODE_COOKIE } from './consts/server.ts'

/** True if the request comes from a device in dev mode */
export function isDevMode(req: IncomingMessage): boolean {
  return readCookie(req, APP_MODE_COOKIE) === 'dev'
}
