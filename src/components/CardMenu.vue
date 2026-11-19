<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { ICON_CHEVRON } from '@/icons'
import { settings } from '@/settings'
import type { MenuDetail, MenuHistory, MenuItem } from '@/types'

/**
 * Popup of actions for a card or folder. It has no button of its own: the
 * owner calls `open()` (exposed), on a right-click or a press-and-hold
 * (useContextHold).
 */
const props = defineProps<{
  items: MenuItem[]
  /** Popup heading, usually the card's name */
  title: string
  subtitle?: string
  /** Facts shown above the actions, e.g. dates ("Added", "Last viewed") */
  details?: MenuDetail[]
  /**
   * A mini section under the facts: one fact that stays in its place, and a
   * list of dates under it that opens and closes (loaded when it's opened)
   */
  history?: MenuHistory
  /** More facts, under the mini section (or under `details` when there's none) */
  moreDetails?: MenuDetail[]
  /**
   * Buttons show only their icon (the label is the tooltip and the
   * screen-reader name; descriptions aren't shown). While an action runs or
   * shows its result, that text appears next to its icon
   */
  iconOnly?: boolean
}>()

const open = ref(false)

/** The items by row: neighbors with the same `row` together, each other item alone */
const rows = computed(() => {
  const list: MenuItem[][] = []
  for (const item of props.items) {
    const last = list[list.length - 1] as MenuItem[] | undefined
    if (item.row && last?.[0].row === item.row) last.push(item)
    else list.push([item])
  }
  return list
})

defineExpose({
  open() {
    open.value = true
  },
})
/** Item whose `confirm` question is on screen instead of the list */
const confirming = ref<MenuItem | null>(null)
/** The item whose action is running */
const running = ref<MenuItem | null>(null)
/** Result of the last action, shown in place of its label for a moment */
const status = ref<{ item: MenuItem; text: string; failed: boolean } | null>(null)
let statusTimer: ReturnType<typeof setTimeout> | undefined

// ── The mini section's list of dates ──

const historyOpen = ref(false)
/** The dates, once loaded (null: not asked yet, or it failed) */
const historyDates = ref<string[] | null>(null)
const historyLoading = ref(false)
const historyFailed = ref(false)

/** Opens the list (asking for the dates each time, so they're current) or closes it */
async function toggleHistory() {
  if (historyOpen.value) {
    historyOpen.value = false
    return
  }
  const history = props.history
  if (!history) return
  historyOpen.value = true
  historyLoading.value = true
  historyFailed.value = false
  try {
    historyDates.value = await history.load()
  } catch {
    historyDates.value = null
    historyFailed.value = true
  } finally {
    historyLoading.value = false
  }
}

function close() {
  if (running.value) return
  clearTimeout(statusTimer)
  open.value = false
  confirming.value = null
  status.value = null
  historyOpen.value = false
  historyDates.value = null
}

function pick(item: MenuItem) {
  if (running.value) return
  status.value = null
  if (item.confirm) confirming.value = item
  else void run(item)
}

async function run(item: MenuItem) {
  if (running.value) return
  running.value = item
  // called right in the click handler: anything `run` does before its first
  // await (like opening the file picker) still counts as a user tap
  const action = item.run()
  try {
    const result = await action
    confirming.value = null
    if (result === null) {
      running.value = null
      return close()
    }
    status.value = { item, text: result, failed: false }
  } catch (e) {
    confirming.value = null
    status.value = { item, text: e instanceof Error ? e.message : 'Failed', failed: true }
  } finally {
    running.value = null
  }
  clearTimeout(statusTimer)
  statusTimer = setTimeout(close, settings.menuStatusMs)
}

/** What a running item says (its busyLabel, which may be live) */
function busyText(item: MenuItem): string {
  const busy = item.busyLabel
  return typeof busy === 'function' ? busy() : (busy ?? item.label)
}

function labelOf(item: MenuItem): string {
  if (running.value === item) return busyText(item)
  if (status.value?.item === item) return status.value.text
  return item.label
}

onUnmounted(() => clearTimeout(statusTimer))
</script>

<template>
  <ModalDialog v-if="open" :title="title" :subtitle="subtitle" :locked="running !== null" @close="close">
    <!-- Asking before a destructive / heavy action -->
    <div v-if="confirming" class="confirm">
      <p class="confirm-text">{{ confirming.confirm?.message }}</p>
      <div class="actions">
        <button class="button" :disabled="running !== null" @click="confirming = null">
          Cancel
        </button>
        <button
          class="button"
          :class="confirming.danger ? 'danger' : 'primary'"
          :disabled="running !== null"
          @click="run(confirming)"
        >
          {{
            running === confirming
              ? busyText(confirming)
              : (confirming.confirm?.confirmLabel ?? confirming.label)
          }}
        </button>
      </div>
    </div>

    <!-- Facts about it (dates), above the actions -->
    <div v-if="!confirming && (details?.length || history || moreDetails?.length)" class="facts">
      <dl v-if="details?.length" class="details part">
        <template v-for="d in details" :key="d.label">
          <dt>{{ d.label }}</dt>
          <dd>
            {{ d.value }}
            <span v-if="d.note" class="detail-note">{{ d.note }}</span>
          </dd>
        </template>
      </dl>

      <!-- mini section: its fact stays where it is; the list of dates under it opens and closes -->
      <section v-if="history" class="history part">
        <dl class="details">
          <dt>{{ history.fact.label }}</dt>
          <dd>
            {{ history.fact.value }}
            <span v-if="history.fact.note" class="detail-note">{{ history.fact.note }}</span>
          </dd>
        </dl>
        <button
          type="button"
          class="history-toggle"
          :aria-expanded="historyOpen"
          @click="toggleHistory"
        >
          <svg class="chevron" :class="{ open: historyOpen }" viewBox="0 0 24 24" aria-hidden="true">
            <path :d="ICON_CHEVRON" />
          </svg>
          {{ history.listLabel }}
          <span v-if="historyDates" class="history-count">{{ historyDates.length }}</span>
        </button>
        <div v-if="historyOpen" class="history-list">
          <p v-if="historyLoading" class="history-note">Loading…</p>
          <p v-else-if="historyFailed" class="history-note">The dates could not be loaded</p>
          <p v-else-if="!historyDates?.length" class="history-note">{{ history.emptyText }}</p>
          <ul v-else>
            <li v-for="(date, i) in historyDates" :key="i">{{ date }}</li>
          </ul>
        </div>
      </section>

      <dl v-if="moreDetails?.length" class="details part">
        <template v-for="d in moreDetails" :key="d.label">
          <dt>{{ d.label }}</dt>
          <dd>
            {{ d.value }}
            <span v-if="d.note" class="detail-note">{{ d.note }}</span>
          </dd>
        </template>
      </dl>
    </div>

    <!-- The actions -->
    <div v-if="!confirming" class="menu-list">
      <div v-for="row in rows" :key="row[0].label" class="menu-row">
      <button
        v-for="item in row"
        :key="item.label"
        class="menu-item"
        :aria-label="iconOnly ? labelOf(item) : undefined"
        :title="item.disabled && item.disabledReason ? item.disabledReason : iconOnly ? item.label : undefined"
        :class="{
          'icon-only': iconOnly,
          danger: item.danger,
          running: running === item,
          done: status?.item === item && !status.failed,
          failed: status?.item === item && status.failed,
        }"
        :disabled="running !== null || item.disabled"
        @click="pick(item)"
      >
        <!-- while its action runs, a spinner takes the icon's place. Icon
             only: right in the button, which is its frame already; else
             in a little box of its own, beside the text -->
        <template v-if="iconOnly">
          <span v-if="running === item" class="spinner" role="status" aria-label="Working" />
          <svg v-else-if="item.icon" class="bare-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path :d="item.icon" />
          </svg>
        </template>
        <span v-else-if="item.icon || running === item" class="icon">
          <span v-if="running === item" class="spinner" role="status" aria-label="Working" />
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon" /></svg>
        </span>
        <!-- icon only: text just while it runs or shows its result -->
        <span
          v-if="!iconOnly || running === item || status?.item === item"
          class="text"
        >
          <span class="label">{{ labelOf(item) }}</span>
          <span v-if="item.description && !iconOnly" class="description">
            {{ item.description }}
          </span>
        </span>
      </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* ── Facts (dates) ── */
.facts {
  margin: 0 0 0.75rem;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--edge-soft);
  border-radius: 0.8rem;
  background: rgba(255, 255, 255, 0.025);
  font-size: 0.8rem;
}

.details {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 0.9rem;
  margin: 0;
}

.details dt {
  color: #8f88aa;
}

.details dd {
  margin: 0;
  color: #ddd;
  font-variant-numeric: tabular-nums;
}

/* e.g. how long ago: its own line under the value, dimmer */
.detail-note {
  display: block;
  color: #8f88aa;
}

/* the parts of the facts panel (facts, mini section, more facts): set apart by a line */
.part + .part {
  margin-top: 0.55rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--edge-soft);
}

.history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.4rem;
  padding: 0.2rem 0.1rem;
  border: none;
  background: none;
  color: #8f88aa;
  font-size: 0.78rem;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.12s;
}

.history-toggle:hover {
  color: #ddd;
}

.history-toggle:focus-visible {
  outline: 2px solid #8a5cf6;
  outline-offset: 2px;
  border-radius: 0.3rem;
}

/* points down when open, right when closed */
.chevron {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
  transform: rotate(-90deg);
  transition: transform 0.15s;
}

.chevron.open {
  transform: none;
}

.history-count {
  padding: 0 0.4rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: #ccc;
  font-variant-numeric: tabular-nums;
}

/* many dates scroll inside it, so the popup doesn't grow past the screen */
.history-list {
  max-height: 9rem;
  margin-top: 0.3rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.history-list ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-list li {
  padding: 0.15rem 0;
  color: #ddd;
  font-variant-numeric: tabular-nums;
}

.history-note {
  margin: 0;
  color: #8f88aa;
}

@media (prefers-reduced-motion: reduce) {
  .chevron {
    transition: none;
  }
}

/* ── Action list ── */
.menu-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

/* one row: a single item, or items sharing it (MenuItem.row) in equal widths */
.menu-row {
  display: flex;
  gap: 0.4rem;
}

.menu-item {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 0.8rem;
  width: 100%;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--edge-soft);
  border-radius: 0.8rem;
  background: rgba(255, 255, 255, 0.04);
  color: #e4e4e4;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s;
}

/* icon only: the icon in the middle of the button */
.menu-item.icon-only {
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem;
}

.menu-item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.09);
  border-color: var(--edge);
  color: #fff;
}

.menu-item:disabled {
  cursor: default;
  opacity: 0.6;
}

/* the one that's working stays bright, so its spinner and progress read well */
.menu-item.running:disabled {
  opacity: 1;
}

.icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.07);
}

.icon svg,
.bare-icon {
  width: 1.2rem;
  height: 1.2rem;
  fill: currentColor;
}

/* icon only: as tall as the boxed icons, so the buttons keep their height */
.bare-icon {
  flex: none;
  /* 0.5rem padding + 0.75rem + 1.2rem icon = the boxed ones' 0.75rem + 2.2rem */
  margin-block: 0.75rem;
}

/* the running action, in the icon's place (like the upload / compress dialogs' spinners) */
.spinner {
  width: 1.1rem;
  height: 1.1rem;
  box-sizing: border-box;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: #8a5cf6;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}

.text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.label {
  font-size: 1rem;
}

.description {
  color: #888;
  font-size: 0.8rem;
}

.menu-item.danger {
  color: #f07060;
}

.menu-item.danger .icon {
  background: rgba(231, 76, 60, 0.15);
}

.menu-item.danger:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.14);
  border-color: rgba(231, 76, 60, 0.3);
  color: #ff8a7a;
}

.menu-item.done .label {
  color: #6fdc8c;
}

.menu-item.failed .label {
  color: #f07060;
}

/* ── Confirmation ── */
.confirm {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm-text {
  margin: 0;
  color: #ccc;
  font-size: 0.97rem;
  line-height: 1.5;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
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

.button.danger {
  border-color: #c0392b;
  background: #c0392b;
  color: #fff;
}

.button.danger:hover:not(:disabled) {
  background: #d94434;
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
