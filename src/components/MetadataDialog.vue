<script setup lang="ts">
import { computed, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import NumberStepper from '@/components/NumberStepper.vue'
import { setPlays, setWatchTime } from '@/api'
import { recordsVideoData } from '@/appMode'
import { MAX_SET_PLAYS, MAX_SET_WATCH_HOURS } from '@/constants'
import type { Entry } from '@/types'
import { formatWatched } from '@/utils/format'

/**
 * Edits what's recorded about a video or photo, on every device: its views
 * (server/plays.ts) and its time watched (server/watchTime.ts), as hours,
 * minutes and seconds. Each has its own − / + buttons (NumberStepper), which
 * carry over (+ on 59 s gives 1 min 0 s). Dev mode: shown, but can't be
 * changed (the server refuses it, src/appMode.ts).
 */
const props = defineProps<{ entry: Entry }>()
/** `changed`: something was saved, so the listing should be reloaded */
const emit = defineEmits<{ close: []; changed: [] }>()

const isPhoto = props.entry.kind === 'image'
const locked = computed(() => !recordsVideoData.value)

// ── Views ──
const savedViews = props.entry.plays ?? 0
const views = ref(savedViews)

// ── Time watched: kept as whole seconds, shown as h / min / s ──
const MAX_SECONDS = MAX_SET_WATCH_HOURS * 3600
const savedSeconds = Math.floor((props.entry.watched_ms ?? 0) / 1000)
const seconds = ref(savedSeconds)

const clampSeconds = (s: number) => Math.min(MAX_SECONDS, Math.max(0, Math.round(s)))

/** One unit of the time: its value, and the steppers' limits so the total stays in range */
function unit(size: number, of: (total: number) => number) {
  return computed({
    get: () => of(seconds.value),
    // a typed or stepped value carries over into the others (90 min → 1 h 30 min)
    set: (value: number) => {
      seconds.value = clampSeconds(seconds.value + (value - of(seconds.value)) * size)
    },
  })
}
const hours = unit(3600, (t) => Math.floor(t / 3600))
const minutes = unit(60, (t) => Math.floor(t / 60) % 60)
const secs = unit(1, (t) => t % 60)

/** How far a unit's buttons may go: not below 0 in all, not over the most */
const lowest = (value: number, size: number) => value - Math.floor(seconds.value / size)
const highest = (value: number, size: number) =>
  value + Math.floor((MAX_SECONDS - seconds.value) / size)

// ── Saving ──
const viewsChanged = computed(() => views.value !== savedViews)
const timeChanged = computed(() => seconds.value !== savedSeconds)
const viewsProblem = computed(() =>
  views.value > MAX_SET_PLAYS ? `Views must be at most ${MAX_SET_PLAYS}` : null,
)

const saving = ref(false)
const error = ref('')
const canSave = computed(
  () =>
    !locked.value &&
    !saving.value &&
    !viewsProblem.value &&
    (viewsChanged.value || timeChanged.value),
)

/** Something was saved: the folder is listed again when the dialog closes */
let anythingSaved = false

async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  try {
    if (viewsChanged.value) {
      await setPlays(props.entry.path, views.value)
      anythingSaved = true
    }
    if (timeChanged.value) {
      await setWatchTime(props.entry.path, seconds.value * 1000)
      anythingSaved = true
    }
    close()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Saving failed'
  } finally {
    saving.value = false
  }
}

function reset() {
  views.value = savedViews
  seconds.value = savedSeconds
}

function close() {
  if (anythingSaved) emit('changed')
  emit('close')
}
</script>

<template>
  <ModalDialog title="Edit metadata" :subtitle="entry.name" :locked="saving" @close="close">
    <form class="form" @submit.prevent="save">
      <div class="field">
        <span class="field-label">Views</span>
        <NumberStepper
          v-model="views"
          label="views"
          :min="0"
          :max="MAX_SET_PLAYS"
          :disabled="saving || locked"
          @enter="save"
        />
      </div>

      <div class="field">
        <span class="field-label">
          {{ isPhoto ? 'Time shown' : 'Time watched' }}
          <span class="field-total">{{ formatWatched(seconds * 1000) }}</span>
        </span>
        <div class="time">
          <!-- divs, not labels: a label's text would press its first button (−) -->
          <div class="unit">
            <NumberStepper
              v-model="hours"
              label="hours"
              :min="lowest(hours, 3600)"
              :max="highest(hours, 3600)"
              :disabled="saving || locked"
              @enter="save"
            />
            <span class="unit-name">hours</span>
          </div>
          <div class="unit">
            <NumberStepper
              v-model="minutes"
              label="minutes"
              :min="lowest(minutes, 60)"
              :max="highest(minutes, 60)"
              :disabled="saving || locked"
              @enter="save"
            />
            <span class="unit-name">minutes</span>
          </div>
          <div class="unit">
            <NumberStepper
              v-model="secs"
              label="seconds"
              :min="lowest(secs, 1)"
              :max="highest(secs, 1)"
              :disabled="saving || locked"
              @enter="save"
            />
            <span class="unit-name">seconds</span>
          </div>
        </div>
      </div>

      <p v-if="locked" class="note">Switch to goon mode to change these.</p>
      <p v-else-if="viewsChanged && views === 0" class="note">
        With 0 views, “Last viewed” goes back to Never.
      </p>
      <p v-if="viewsProblem ?? error" class="error">{{ viewsProblem ?? error }}</p>

      <div class="actions">
        <button
          type="button"
          class="button"
          :disabled="saving || (!viewsChanged && !timeChanged)"
          @click="reset"
        >
          Reset
        </button>
        <span class="spacer" />
        <button type="button" class="button" :disabled="saving" @click="close">Cancel</button>
        <button type="submit" class="button primary" :disabled="!canSave">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </form>
  </ModalDialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.field-label {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  color: #aaa;
  font-size: 0.75rem;
}

/* the time as the cards show it, beside the label */
.field-total {
  color: #ddd;
  font-variant-numeric: tabular-nums;
}

.time {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.unit {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.unit-name {
  color: #888;
  font-size: 0.7rem;
  text-align: center;
}

.note {
  margin: 0;
  color: #aaa;
  font-size: 0.78rem;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spacer {
  flex: 1;
}

.button {
  padding: 0.55rem 1rem;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  cursor: pointer;
}

.button:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
}

.button.primary {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.button.primary:hover:not(:disabled) {
  background: #3b7bf0;
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
