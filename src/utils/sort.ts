import type { SortBy } from '@/constants'
import type { Entry } from '@/types'

function byName(a: Entry, b: Entry): number {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** Folders, then videos, then everything else */
function rank(e: Entry): number {
  return e.kind === 'folder' ? 0 : e.kind === 'video' ? 1 : 2
}

/** The value `by` sorts on, biggest first; null sorts last */
function sortValue(e: Entry, by: SortBy): number | null {
  switch (by) {
    case 'duration':
    case 'favorites': // after the hearts come first (see sortEntries)
      return e.duration ?? null
    case 'size':
      return e.size ?? null
    case 'quality':
      // most pixels first; the frame rate (always under 1000) only breaks ties
      // between the same size, so 1080p60 comes before 1080p30
      return e.width && e.height ? e.width * e.height + (e.fps ?? 0) / 1000 : null
    case 'date added':
      return e.added ?? null
  }
}

/**
 * A sorted copy of a folder listing. Folders always come first, by name.
 * The files after them are in order of `by`, biggest / longest / sharpest /
 * newest first, with videos before other files; ties (and files without the
 * value, like images by duration or quality) go by name. By "favorites", the hearted files come
 * first (videos, then photos), then the rest, each part by duration.
 */
export function sortEntries(entries: Entry[], by: SortBy): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === 'folder' || b.kind === 'folder') {
      const byRank = rank(a) - rank(b)
      return byRank !== 0 ? byRank : byName(a, b)
    }
    if (by === 'favorites' && Boolean(a.favorite) !== Boolean(b.favorite)) {
      return a.favorite ? -1 : 1
    }
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const x = sortValue(a, by)
    const y = sortValue(b, by)
    if (x !== y) {
      if (x === null) return 1
      if (y === null) return -1
      return y - x
    }
    return byName(a, b)
  })
}
