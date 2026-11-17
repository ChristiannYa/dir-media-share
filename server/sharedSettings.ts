// App settings shared by every device (sort, video player, look, background…).
// The app owns them: it knows their fields, defaults and limits
// (src/settings.ts) and checks them itself; the server only keeps them, in
// SHARED_SETTINGS_FILE, so every phone and computer gets the same ones.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SHARED_SETTINGS_FILE } from './consts/server.ts'

type Value = string | number | boolean
export type SharedSettings = Record<string, Value>

/** Far more than the app has; anything bigger isn't a real request */
const MAX_KEYS = 200
const MAX_KEY_LENGTH = 100
const MAX_STRING_LENGTH = 1000

function isValue(value: unknown): value is Value {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= MAX_STRING_LENGTH)
  )
}

/** `input` as shared settings, or null if it isn't a small object of plain values */
export function asSharedSettings(input: unknown): SharedSettings | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const entries = Object.entries(input)
  if (entries.length > MAX_KEYS) return null
  for (const [key, value] of entries) {
    if (key.length > MAX_KEY_LENGTH || !isValue(value)) return null
  }
  return Object.fromEntries(entries) as SharedSettings
}

function load(): SharedSettings {
  try {
    return asSharedSettings(JSON.parse(readFileSync(SHARED_SETTINGS_FILE, 'utf8'))) ?? {}
  } catch {
    return {} // no file yet (or unreadable): the app's defaults
  }
}

let shared: SharedSettings = load()

/** The saved shared settings (only the ones that differ from the app's defaults) */
export function sharedSettings(): SharedSettings {
  return shared
}

/** Replaces the shared settings with `next` and saves them */
export async function saveSharedSettings(next: SharedSettings): Promise<void> {
  // write a temp file, then rename: a crash mid-write can't leave half a file
  await mkdir(path.dirname(SHARED_SETTINGS_FILE), { recursive: true })
  const tmp = `${SHARED_SETTINGS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
  await rename(tmp, SHARED_SETTINGS_FILE)
  shared = next
  console.log('Shared settings changed:', next)
}
