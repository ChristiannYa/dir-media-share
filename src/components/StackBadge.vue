<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { BADGES, type BadgeName } from '@/constants'
import {
  BADGE_SETTLE_MS,
  BADGE_STACK_STATE_KEY,
  BADGE_TARGETS_KEY,
} from '@/composables/useBadgeStack'

/**
 * One badge / pill in a card's top-left stack. `badge` is its entry in BADGES
 * (constants.ts): its kind says where it goes, wherever it's written (even in
 * a component inside the card, like PreviewVideo; the card provides the
 * places: BADGE_TARGETS_KEY):
 * - temporal: in the column. The badge with the highest priority is on top,
 *   the others follow in priority order. While one is visible the card hides
 *   its top-right badges
 * - metadata: in the row at the bottom of the column, side by side, the
 *   highest priority on the left
 *
 * `show` opens it (it grows in from nothing, which pushes the ones after it
 * along) and closes it (it fades and shrinks away, so those slide up / left
 * into its place: no empty space is left). A closing waits until the stack has
 * been still for BADGE_SETTLE_MS, so a badge that just slid into place isn't
 * gone a moment later. It stays in the page while closed, at no size, so it
 * can open again.
 */
const props = defineProps<{
  badge: BadgeName
  show: boolean
}>()

const state = inject(BADGE_STACK_STATE_KEY, null)
const targets = inject(BADGE_TARGETS_KEY, null)
const info = computed(() => BADGES[props.badge])
const inRow = computed(() => info.value.kind === 'metadata')
/** Where it's drawn: null until the card has drawn it (then it's where it's written) */
const target = computed(() => (inRow.value ? targets?.row.value : targets?.stack.value) ?? null)

/** Drawn at least once closed, so that a badge that starts open still opens (animated) */
const ready = ref(false)
/** Drawn open (the leaving is delayed, so this lags `show`) */
const open = ref(false)
let leaveTimer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => (ready.value = true)))
})

/** Opens or closes it for real, and tells the stack */
function setOpen(value: boolean) {
  if (open.value === value) return
  open.value = value
  if (!state) return
  state[info.value.kind] += value ? 1 : -1
  state.lastChange = performance.now()
}

watch(
  () => ready.value && props.show,
  (want) => {
    clearTimeout(leaveTimer)
    if (want) return setOpen(true)
    if (!open.value) return
    const wait = state ? Math.max(0, state.lastChange + BADGE_SETTLE_MS - performance.now()) : 0
    if (wait === 0) setOpen(false)
    else leaveTimer = setTimeout(() => setOpen(false), wait)
  },
  { immediate: true },
)

onUnmounted(() => {
  clearTimeout(leaveTimer)
  // no longer counted (not through setOpen: the stack's timing mustn't change)
  if (open.value && state) state[info.value.kind] -= 1
})
</script>

<template>
  <Teleport :to="target ?? 'body'" :disabled="!target">
    <!-- higher priority = earlier: `order` puts it higher in the column (or further left in the row) -->
    <div
      class="stack-slot"
      :class="{ open, 'in-row': inRow }"
      :style="{ order: -info.priority }"
      :aria-hidden="!open"
    >
      <div class="stack-inner">
        <!-- the gap under the badge is in here: the clipped part, so a closed slot is 0 tall -->
        <div class="stack-pad"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* a row of height 0 that grows to its content (grid-template-rows animates;
   height: auto doesn't) */
.stack-slot {
  display: grid;
  grid-template-rows: 0fr;
  max-width: 100%;
  min-width: 0;
  opacity: 0;
  /* not hoverable / readable while closed */
  visibility: hidden;
  transition:
    grid-template-rows 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.25s ease,
    visibility 0s linear 0.32s;
}

.stack-slot.open {
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  transition:
    grid-template-rows 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.25s ease 0.05s,
    visibility 0s;
}

/* in the row: it opens sideways too, so the ones beside it slide along (a
   closed one takes no width) */
.stack-slot.in-row {
  grid-template-columns: 0fr;
  transition:
    grid-template-rows 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    grid-template-columns 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.25s ease,
    visibility 0s linear 0.32s;
}

.stack-slot.in-row.open {
  grid-template-columns: 1fr;
  transition:
    grid-template-rows 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    grid-template-columns 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.25s ease 0.05s,
    visibility 0s;
}

/* the gap to the next badge of the row, inside the clipped part like the one below */
.stack-slot.in-row .stack-pad {
  padding-right: 0.3rem;
}

/* clips the badge while the row is shorter than it */
.stack-inner {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

/* the badge, and the gap under it: inside the clipped box, so it opens and
   closes with the row (padding on .stack-inner itself would keep a closed
   slot 0.3rem tall, and the badges under it would sit lower than they should) */
.stack-pad {
  min-width: 0;
  padding-bottom: 0.3rem;
}

@media (prefers-reduced-motion: reduce) {
  .stack-slot,
  .stack-slot.open,
  .stack-slot.in-row,
  .stack-slot.in-row.open {
    transition: none;
  }
}
</style>
