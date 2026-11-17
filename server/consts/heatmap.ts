// "Most watched parts" of videos (server/heatmap.ts).

/**
 * How many equal parts each video is cut into for counting what was watched.
 * Keep in sync with HEATMAP_BINS in the Vue app's src/constants.ts. Changing
 * it drops the counts saved so far.
 */
export const HEATMAP_BINS = 100
/**
 * Most a single part may go up by in one report: a few minutes of rewatching
 * one spot at most, so a broken or hostile client can't swamp the map
 */
export const HEATMAP_MAX_ADD = 50
/** Biggest request body of a report (100 small numbers fit easily) */
export const HEATMAP_MAX_BODY_BYTES = 4096
