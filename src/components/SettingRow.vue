<script setup lang="ts">
import type { SettingsDraft } from '@/composables/useSettingsDraft'
import type { FieldSpec } from '@/settings'

/** One setting in the Settings popup: label, help, and the right input for its type */
const props = defineProps<{
  field: FieldSpec
  form: SettingsDraft
  /** Set when the same field is shown twice (Frequently changed), so their ids differ */
  idSuffix?: string
}>()

const id = `setting-${props.field.key}${props.idSuffix ? `-${props.idSuffix}` : ''}`
</script>

<template>
  <div
    class="field"
    :class="{ changed: form.isChanged(field.key), invalid: form.problems.value[field.key] }"
  >
    <div class="field-text">
      <label class="label" :for="id">{{ field.label }}</label>
      <p class="help">{{ field.help }}</p>
      <p v-if="form.problems.value[field.key]" class="problem">
        {{ form.problems.value[field.key] }}
      </p>
    </div>

    <!-- On / off -->
    <button
      v-if="field.type === 'boolean'"
      :id="id"
      type="button"
      class="switch"
      role="switch"
      :aria-checked="form.draft[field.key] === true"
      @click="form.setValue(field, form.draft[field.key] !== true)"
    >
      <span class="knob" />
    </button>

    <!-- One of a list -->
    <select
      v-else-if="field.type === 'select'"
      :id="id"
      class="input select"
      :value="form.draft[field.key]"
      @change="form.setValue(field, ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
    </select>

    <!-- Number, with its unit -->
    <div v-else-if="field.type === 'number'" class="input-wrap">
      <input
        :id="id"
        class="input number"
        type="number"
        inputmode="decimal"
        :min="field.min"
        :max="field.max"
        :step="field.step"
        :value="form.text[field.key]"
        @input="form.onInput(field, ($event.target as HTMLInputElement).value)"
      />
      <span class="unit">{{ field.unit ?? '' }}</span>
    </div>

    <!-- CSS margin -->
    <input
      v-else
      :id="id"
      class="input margin"
      type="text"
      autocomplete="off"
      spellcheck="false"
      :value="form.text[field.key]"
      @input="form.onInput(field, ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.field {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--edge-soft);
  border-left: 3px solid transparent;
  border-radius: 0.7rem;
  background: rgba(255, 255, 255, 0.035);
  transition: border-color 0.12s;
}

/* edited but not applied yet */
.field.changed {
  border-left-color: #2d6cdf;
}

.field.invalid {
  border-left-color: #c0392b;
}

.field-text {
  flex: 1;
  min-width: 0;
}

.label {
  font-size: 0.86rem;
  color: #e4e4e4;
}

.help {
  margin: 0.15rem 0 0;
  color: #807a92;
  font-size: 0.72rem;
  line-height: 1.4;
}

.problem {
  margin: 0.25rem 0 0;
  color: #f07060;
  font-size: 0.72rem;
}

/* ── Inputs ── */
.input-wrap {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.input {
  box-sizing: border-box;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.35);
  color: #eee;
  /* 16px+: iOS zooms the page into smaller inputs */
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  outline: none;
}

.input:focus {
  border-color: #2d6cdf;
}

.field.invalid .input {
  border-color: #c0392b;
}

.input.number {
  width: 6rem;
  text-align: right;
}

.input.margin,
.input.select {
  width: 8rem;
}

.select option {
  background: #1a1a1a;
}

.unit {
  width: 1.8rem;
  color: #888;
  font-size: 0.75rem;
}

/* ── Switch ── */
.switch {
  flex: none;
  position: relative;
  width: 2.6rem;
  height: 1.5rem;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.15);
  cursor: pointer;
  transition: background 0.15s;
}

.switch[aria-checked='true'] {
  background: #2d6cdf;
}

.knob {
  position: absolute;
  top: 0.2rem;
  left: 0.2rem;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}

.switch[aria-checked='true'] .knob {
  transform: translateX(1.1rem);
}

@media (max-width: 480px) {
  .field {
    flex-wrap: wrap;
  }

  .field-text {
    flex-basis: 100%;
  }
}
</style>
