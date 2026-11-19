<script setup lang="ts">
import { nextTick, onUnmounted } from 'vue'

/**
 * A whole number with − and + buttons on its sides, in the app's buttons'
 * style (instead of the browser's own number arrows). A tap steps once;
 * holding a button keeps stepping after HOLD_DELAY_MS, every REPEAT_MS.
 * Typed values are sent as they are (not clamped), so the parent can carry
 * them over (90 minutes → 1 h 30 min); the buttons stay within `min` / `max`
 * when given.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number
    /** Its name, for screen readers and the buttons' tooltips */
    label: string
    min?: number
    max?: number
    step?: number
    disabled?: boolean
  }>(),
  { min: -Infinity, max: Infinity, step: 1, disabled: false },
)
const emit = defineEmits<{ 'update:modelValue': [value: number]; enter: [] }>()

/** How long a button is held before it starts repeating, then how often it steps (ms) */
const HOLD_DELAY_MS = 400
const REPEAT_MS = 70

function bump(dir: 1 | -1) {
  const next = Math.min(props.max, Math.max(props.min, props.modelValue + dir * props.step))
  if (next !== props.modelValue) emit('update:modelValue', next)
  // at the end: the button goes disabled and may never hear the pointer go up
  if (next <= props.min || next >= props.max) release()
}

let holdTimer: ReturnType<typeof setTimeout> | undefined
let repeatTimer: ReturnType<typeof setInterval> | undefined
/** The press turned into a hold: the click that ends it doesn't step again */
let held = false

function press(dir: 1 | -1) {
  release()
  held = false
  holdTimer = setTimeout(() => {
    held = true
    bump(dir)
    repeatTimer = setInterval(() => bump(dir), REPEAT_MS)
  }, HOLD_DELAY_MS)
}

function release() {
  clearTimeout(holdTimer)
  clearInterval(repeatTimer)
}

/** A tap (or Enter / Space on the focused button) steps once; the end of a hold doesn't */
function click(dir: 1 | -1) {
  if (held) {
    held = false
    return
  }
  bump(dir)
}

async function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  const digits = el.value.replace(/[^\d]/g, '')
  emit('update:modelValue', digits === '' ? 0 : Number(digits))
  // the parent may have carried it over (60 min → 1 h 0 min): when the number
  // ends up the same as before, Vue doesn't redraw the box, so it's set here
  await nextTick()
  if (el.value !== String(props.modelValue)) el.value = String(props.modelValue)
}

/** Arrow keys in the box step like the buttons */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    bump(e.key === 'ArrowUp' ? 1 : -1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    emit('enter')
  }
}

onUnmounted(release)
</script>

<template>
  <div class="stepper" :class="{ disabled }">
    <button
      type="button"
      class="step"
      :aria-label="`Less ${label}`"
      :title="`Less ${label}`"
      :disabled="disabled || modelValue <= min"
      @pointerdown="press(-1)"
      @pointerup="release"
      @pointerleave="release"
      @pointercancel="release"
      @click="click(-1)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z" /></svg>
    </button>
    <input
      class="value"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      enterkeyhint="done"
      :aria-label="label"
      :value="modelValue"
      :disabled="disabled"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      type="button"
      class="step"
      :aria-label="`More ${label}`"
      :title="`More ${label}`"
      :disabled="disabled || modelValue >= max"
      @pointerdown="press(1)"
      @pointerup="release"
      @pointerleave="release"
      @pointercancel="release"
      @click="click(1)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" /></svg>
    </button>
  </div>
</template>

<style scoped>
/* one control: the buttons and the box share the inputs' edge and corners */
.stepper {
  display: flex;
  align-items: stretch;
  min-width: 0;
  border: 1px solid var(--edge);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.35);
  overflow: hidden;
  transition: border-color 0.12s;
}

.stepper:focus-within {
  border-color: #2d6cdf;
}

.stepper.disabled {
  opacity: 0.5;
}

/* the app's buttons (#1f1f1f, the edge's shine), as the control's ends */
.step {
  flex: none;
  display: grid;
  place-items: center;
  width: 2.4rem;
  padding: 0;
  border: none;
  background: #1f1f1f;
  box-shadow: var(--edge-shine);
  color: #ddd;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    background 0.12s,
    color 0.12s;
}

.step svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}

.step:hover:not(:disabled) {
  background: #2a2a2a;
  color: #fff;
}

.step:active:not(:disabled) {
  background: #2d6cdf;
  color: #fff;
}

.step:focus-visible {
  outline: 2px solid #2d6cdf;
  outline-offset: -2px;
}

.step:disabled {
  color: #666;
  cursor: default;
}

.value {
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0.6rem 0.4rem;
  border: none;
  background: none;
  color: #eee;
  /* 16px+: iOS zooms the page into smaller inputs */
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
  outline: none;
}
</style>
