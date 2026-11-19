export function formatDuration(seconds: number): string {
  if (isNaN(seconds)) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Short date as month.day.year, then the time on a 12-hour clock with
 * seconds, without leading zeros on the month, day or hour:
 * April 6 2026, 16:06:30 → "4.6.26 4:06:30 PM"
 */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  const year = String(d.getFullYear() % 100).padStart(2, '0')
  const hour = d.getHours() % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const half = d.getHours() < 12 ? 'AM' : 'PM'
  return `${d.getMonth() + 1}.${d.getDate()}.${year} ${hour}:${minutes}:${seconds} ${half}`
}

/**
 * Long date: the month's name, the day and the full year, then the time on
 * a 12-hour clock with seconds:
 * April 1 2026, 16:06:30 → "April 1, 2026, 4:06:30 PM"
 */
export function formatLongDate(ms: number): string {
  const d = new Date(ms)
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${date}, ${time}`
}

/** Standard video sizes, biggest first: name, short side, long side (px) */
const QUALITY_TIERS: ReadonlyArray<[name: string, short: number, long: number]> = [
  ['8K', 4320, 7680],
  ['4K', 2160, 3840],
  ['1440p', 1440, 2560],
  ['1080p', 1080, 1920],
  ['720p', 720, 1280],
  ['480p', 480, 854],
  ['360p', 360, 640],
  ['240p', 240, 426],
]
/** A side this close to a tier's still counts as it (crops, odd encoder sizes) */
const QUALITY_TOLERANCE = 0.9
/** From this frame rate on it's added to the label ("1080p60") */
const QUALITY_HIGH_FPS = 48

/**
 * Quality label of a video, e.g. "1080p", "4K", "720p60". Either side can
 * reach a tier, so a cropped 1920×800 or a portrait 1080×1920 is still
 * "1080p". null if the size is unknown.
 */
export function formatQuality(
  width: number | null | undefined,
  height: number | null | undefined,
  fps?: number | null,
): string | null {
  if (!width || !height) return null
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  const tier = QUALITY_TIERS.find(
    ([, s, l]) => short >= s * QUALITY_TOLERANCE || long >= l * QUALITY_TOLERANCE,
  )
  const name = tier ? tier[0] : `${short}p`
  return fps && fps >= QUALITY_HIGH_FPS ? `${name}${Math.round(fps)}` : name
}

/**
 * How long ago `ms` was, as of `now`, in the biggest whole unit (rounded
 * down): "just now" under a minute, then "5m ago" (minutes), "3h ago",
 * "4d ago", "2w ago", "5mo ago" (months of 30 days; "mo" so it isn't read as
 * minutes), "1y ago" (365 days)
 */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

/** A date with how long ago it was: "4.6.26 4:06:30 PM (3 hours ago)" */
export function formatDateAgo(ms: number, now: number = Date.now()): string {
  return `${formatDate(ms)} (${formatAgo(ms, now)})`
}

/**
 * Time watched, short: "45s", "12m", "3h 12m", "2d 4h" (the smaller unit
 * left out when it's 0: "3h", "2d")
 */
export function formatWatched(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
