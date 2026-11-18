import { reactive, type InjectionKey, type Ref } from 'vue'

/**
 * Provided by a card (GalleryCard.vue): where its top-left badges go
 * (StackBadge.vue puts each in the right one, by its kind in BADGES,
 * constants.ts, so a component inside the card, like PreviewVideo, can draw
 * badges of its own that sit with the card's):
 * - `stack`: the column, for the temporal badges (a status, a new copy)
 * - `row`: one row at the bottom of the column, for the metadata badges (the
 *   views, "Whole video"), side by side
 * Both null until the card has drawn them.
 */
export interface BadgeTargets {
  stack: Ref<HTMLElement | null>
  row: Ref<HTMLElement | null>
}

export const BADGE_TARGETS_KEY: InjectionKey<BadgeTargets> = Symbol('badgeTargets')

/** What the badges of one card's stack share (StackBadge.vue keeps it up to date) */
export interface BadgeStackState {
  /** How many `temporal` badges are visible now (BADGES in constants.ts) */
  temporal: number
  /** How many `metadata` badges are visible now */
  metadata: number
  /** When a badge of the stack last opened or closed (ms, performance.now()) */
  lastChange: number
}

/**
 * Provided by a card next to BADGE_TARGETS_KEY. The card hides its top-right
 * badges while `temporal` is above 0; the badges use `lastChange` to wait
 * before leaving (BADGE_SETTLE_MS)
 */
export const BADGE_STACK_STATE_KEY: InjectionKey<BadgeStackState> = Symbol('badgeStackState')

export function createBadgeStackState(): BadgeStackState {
  return reactive({ temporal: 0, metadata: 0, lastChange: -Infinity })
}

/**
 * A badge that's asked to leave waits until this long after the last time one
 * of the stack opened or closed (ms), so what's left is seen in its new place
 * for a moment before it goes too: the status pill leaves, "Whole video"
 * slides up, and only then leaves itself
 */
export const BADGE_SETTLE_MS = 1500
