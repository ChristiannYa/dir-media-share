<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { SORT_OPTIONS, type SortBy } from '@/constants'
import { setSetting, settings } from '@/settings'

/**
 * The top bar's sort button: shows the current order and opens a small list
 * of the others under it. Same setting as Settings → Sorting → Sort by,
 * shared by every device.
 */

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function pick(option: SortBy) {
  open.value = false
  if (option !== settings.sortBy) setSetting('sortBy', option)
}

// closes on a tap anywhere else, or Escape
function onPointerDown(e: PointerEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    open.value = false
    e.stopPropagation()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeydown, true)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div ref="root" class="sort-menu">
    <button
      type="button"
      class="sort-button"
      :class="{ open }"
      aria-haspopup="listbox"
      :aria-expanded="open"
      title="Sort files by"
      @click="open = !open"
    >
      <!-- bars getting shorter: biggest first -->
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h18v2H3zm0 5h12v2H3zm0 5h6v2H3z" />
      </svg>
      <span>{{ settings.sortBy }}</span>
      <svg class="caret" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </button>

    <ul v-if="open" class="options" role="listbox" aria-label="Sort files by">
      <li v-for="option in SORT_OPTIONS" :key="option">
        <button
          type="button"
          role="option"
          class="option"
          :class="{ current: option === settings.sortBy }"
          :aria-selected="option === settings.sortBy"
          @click="pick(option)"
        >
          {{ option }}
          <svg v-if="option === settings.sortBy" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
          </svg>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sort-menu {
  position: relative;
}

.sort-button {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0;
  border: none;
  background: none;
  color: var(--bar-btn-color);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: capitalize;
  cursor: pointer;
  transition: color 0.15s;
}

.sort-button:hover,
.sort-button.open {
  color: #f0ecff;
}

.sort-button svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}

.sort-button .caret {
  width: 0.9rem;
  height: 0.9rem;
  transition: transform 0.15s;
}

.sort-button.open .caret {
  transform: rotate(180deg);
}

/* the list, under the button: nearly solid, so it reads over the grid */
.options {
  position: absolute;
  z-index: 30;
  top: calc(100% + 0.5rem);
  left: -0.4rem;
  min-width: 11rem;
  margin: 0;
  padding: 0.35rem;
  list-style: none;
  border: 1px solid var(--edge);
  border-radius: 0.8rem;
  background: rgba(20, 18, 30, 0.97);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 12px 32px rgba(0, 0, 0, 0.55);
}

.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: none;
  border-radius: 0.55rem;
  background: none;
  color: #cfc9e3;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-align: left;
  text-transform: capitalize;
  cursor: pointer;
}

.option:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.option.current {
  color: #6ea0ff;
}

.option svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}
</style>
