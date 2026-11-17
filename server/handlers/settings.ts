import { clearObsoleteCache } from '../cachePrune.ts'
import { readJson, sendJson, type Handler } from '../http.ts'
import {
  SERVER_SETTING_DEFAULTS,
  SERVER_SETTING_GROUPS,
  serverSettings,
  updateServerSettings,
} from '../settings.ts'
import { asSharedSettings, saveSharedSettings, sharedSettings } from '../sharedSettings.ts'

/** Settings are a few hundred bytes; anything far bigger isn't a real request */
const MAX_BODY_BYTES = 64 * 1024

/** GET /api/settings : the server settings, their defaults, and how to show them */
export const getSettings: Handler = async (_req, res) => {
  sendJson(res, {
    values: serverSettings,
    defaults: SERVER_SETTING_DEFAULTS,
    groups: SERVER_SETTING_GROUPS,
  })
}

/**
 * POST /api/settings : body `{ "key": value, … }`. All or nothing: if any value
 * is invalid, nothing changes and the answer lists the problems by key.
 */
export const saveSettings: Handler = async (req, res) => {
  let input: unknown
  try {
    input = await readJson(req, MAX_BODY_BYTES)
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }

  const before = { ...serverSettings }
  let problems: Record<string, string> | null
  try {
    problems = await updateServerSettings(input as Record<string, unknown>)
  } catch (e) {
    console.error('Saving the server settings failed:', e)
    return sendJson(res, { error: 'The settings could not be saved' }, 500)
  }
  if (problems) return sendJson(res, { error: 'Some values are invalid', problems }, 400)
  sendJson(res, { values: serverSettings })

  // files made with the old values are never used again: free their space now
  // (in the background; the answer doesn't wait for it)
  const changed = (Object.keys(before) as Array<keyof typeof before>).filter(
    (key) => before[key] !== serverSettings[key],
  )
  void clearObsoleteCache(changed).catch((e) => console.error('Clearing old cache files failed:', e))
}

/** GET /api/shared-settings : the settings shared by every device (only those changed from the app's defaults) */
export const getSharedSettings: Handler = async (_req, res) => {
  sendJson(res, { values: sharedSettings() })
}

/**
 * POST /api/shared-settings : body `{ "key": value, … }`, every shared setting
 * that differs from the app's defaults; replaces the saved ones. The app checks
 * the values; here they only have to be a small object of plain values.
 */
export const saveSharedSettingsHandler: Handler = async (req, res) => {
  let input: unknown
  try {
    input = await readJson(req, MAX_BODY_BYTES)
  } catch {
    return sendJson(res, { error: 'Invalid request' }, 400)
  }
  const next = asSharedSettings(input)
  if (!next) return sendJson(res, { error: 'Invalid request' }, 400)
  try {
    await saveSharedSettings(next)
  } catch (e) {
    console.error('Saving the shared settings failed:', e)
    return sendJson(res, { error: 'The settings could not be saved' }, 500)
  }
  sendJson(res, { values: sharedSettings() })
}
