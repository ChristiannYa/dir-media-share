<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import SettingRow from '@/components/SettingRow.vue'
import {
  bumpCacheVersion,
  clearAllCaches,
  fetchServerSettings,
  previewGeneration,
  saveServerSettings,
  SettingsRejected,
  type ServerSettingsInfo,
} from '@/api'
import { lockNow } from '@/composables/useLock'
import { useSettingsDraft, type SettingsDraft } from '@/composables/useSettingsDraft'
import { CLEAR_ALL_CACHES_CONFIRM, SETTING_USES_STORAGE_KEY } from '@/constants'
import { ICON_CHEVRON } from '@/icons'
import { haptic } from '@/utils/haptics'
import { measureScreenHz, screenHz } from '@/utils/screenRate'
import {
  applySettings,
  DEFAULT_SETTINGS,
  DEVICE_GROUPS,
  settings,
  SHARED_GROUPS,
  type FieldGroup,
  type FieldSpec,
  type Settings,
} from '@/settings'

/**
 * Edits copies of this device's settings, the ones shared by every device,
 * and the server's. Nothing changes until Done, which applies every change on
 * all tabs at once; Cancel / Escape / tapping outside drop them.
 */
const emit = defineEmits<{ close: [] }>()

type Tab = 'device' | 'shared' | 'server'
const tab = ref<Tab>('device')

// ── This device ──
const device = useSettingsDraft(
  () => DEVICE_GROUPS,
  () => settings,
  () => DEFAULT_SETTINGS,
)

// ── All devices (app settings saved on the server) ──
const shared = useSettingsDraft(
  () => SHARED_GROUPS,
  () => settings,
  () => DEFAULT_SETTINGS,
)

// ── Server ──
const server = shallowRef<ServerSettingsInfo | null>(null)
const serverError = ref<string | null>(null)
const remote = useSettingsDraft(
  () => server.value?.groups ?? [],
  () => server.value?.values ?? {},
  () => server.value?.defaults ?? {},
)

async function loadServer() {
  serverError.value = null
  try {
    server.value = await fetchServerSettings()
    remote.load()
  } catch (e) {
    serverError.value = e instanceof Error ? e.message : 'Could not load the server settings'
  }
}

onMounted(() => {
  void loadServer()
  // fresh reading, in case it changed (Low Power Mode, another monitor…)
  measureScreenHz()
})

// ── Clear all caches (Server tab → Caching) ──
// Right away, not on Done: it's an action, not a setting. Every device gets
// fresh stills and previews (api.ts, sharedCacheVersion)

/** The server's section the button is shown in (server/settings.ts) */
const CACHING_GROUP_TITLE = 'Caching'

const clearing = ref(false)
/** What the last clear did ("Removed 120 files"), or why it failed */
const clearResult = ref<{ text: string; failed: boolean } | null>(null)

async function clearAll() {
  if (clearing.value || !confirm(CLEAR_ALL_CACHES_CONFIRM)) return
  clearing.value = true
  clearResult.value = null
  try {
    const removed = await clearAllCaches()
    haptic('tap')
    clearResult.value = {
      text: removed === 1 ? 'Removed 1 file' : `Removed ${removed} files`,
      failed: false,
    }
  } catch (e) {
    clearResult.value = {
      text: e instanceof Error ? e.message : 'Clearing the cache failed',
      failed: true,
    }
  } finally {
    clearing.value = false
  }
}

// ── Done ──
const saving = ref(false)
const saveError = ref<string | null>(null)

/** Each tab's form, name and what "Reset … to defaults" resets */
const TABS: Array<{ id: Tab; label: string; reset: string; form: SettingsDraft }> = [
  { id: 'device', label: 'This device', reset: 'device', form: device },
  { id: 'shared', label: 'App (for all devices)', reset: 'app', form: shared },
  { id: 'server', label: 'Server (for all devices)', reset: 'server', form: remote },
]

function changesIn(form: SettingsDraft): number {
  return Object.keys(form.changes.value).length
}

const deviceChanges = computed(() => changesIn(device))
const sharedChanges = computed(() => changesIn(shared))
const serverChanges = computed(() => changesIn(remote))
const changedCount = computed(() => deviceChanges.value + sharedChanges.value + serverChanges.value)
const hasProblems = computed(() => TABS.some((t) => t.form.hasProblems.value))

const activeTab = computed(() => TABS.find((t) => t.id === tab.value) ?? TABS[0]!)
const activeForm = computed(() => activeTab.value.form)

/** A tab's sections (the server's once loaded) */
function groupsOf(t: Tab): FieldGroup[] {
  if (t === 'device') return DEVICE_GROUPS
  if (t === 'shared') return SHARED_GROUPS
  return server.value?.groups ?? []
}

/** The sections shown on the open tab */
const activeGroups = computed<FieldGroup[]>(() => groupsOf(tab.value))

// ── Frequently changed ──
// Each Done counts every setting it changed ("tab:key" → times), in this
// browser. The most changed ones, from any tab, are listed in a section at
// the top of every tab (Settings → Menus → Frequently changed settings: how
// many). Each row edits that setting on its own tab's form.

const FREQUENT_TITLE = 'Frequently changed'

function readUses(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTING_USES_STORAGE_KEY) ?? '{}')
    return typeof saved === 'object' && saved !== null ? (saved as Record<string, number>) : {}
  } catch {
    return {}
  }
}

const uses = ref(readUses())

function countUses(ids: string[]) {
  if (ids.length === 0) return
  const next = { ...uses.value }
  for (const id of ids) next[id] = (Number(next[id]) || 0) + 1
  uses.value = next
  try {
    localStorage.setItem(SETTING_USES_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable (private window): the counts last until reload
  }
}

interface FrequentItem {
  tab: (typeof TABS)[number]
  field: FieldSpec
  uses: number
}

/** The most changed settings, most first (ties keep the order of the tabs and sections) */
const frequent = computed<FrequentItem[]>(() => {
  const max = settings.frequentSettingsMax
  if (max <= 0) return []
  return TABS.flatMap((t) =>
    groupsOf(t.id).flatMap((g) =>
      g.fields.map((field) => ({ tab: t, field, uses: Number(uses.value[`${t.id}:${field.key}`]) || 0 })),
    ),
  )
    .filter((item) => item.uses > 0)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, max)
})

const frequentOpen = computed(() => openSection[tab.value] === FREQUENT_TITLE)

/** Opens / closes it like any section: the one open on this tab */
function toggleFrequent() {
  openSection[tab.value] = frequentOpen.value ? null : FREQUENT_TITLE
  openSub[tab.value] = null
}

const frequentChanges = computed(
  () => frequent.value.filter((i) => i.field.key in i.tab.form.changes.value).length,
)
const frequentProblems = computed(() =>
  frequent.value.some((i) => i.field.key in i.tab.form.problems.value),
)

// ── Sections ──
// Every section starts collapsed; its header opens and closes it. Like an
// accordion: one section open per tab, and inside it one sub-section, so
// opening another closes the one that was open. Toggling a sub-section only
// touches it (its section stays open).

/** Per tab: the open section's title, and the open sub-section's (inside it) */
const openSection = reactive<Partial<Record<Tab, string | null>>>({})
const openSub = reactive<Partial<Record<Tab, string | null>>>({})

function ownerOf(form: SettingsDraft): Tab {
  return TABS.find((t) => t.form === form)?.id ?? 'server'
}

function isOpen(form: SettingsDraft, group: FieldGroup): boolean {
  return openSection[ownerOf(form)] === group.title
}

function toggleSection(form: SettingsDraft, group: FieldGroup) {
  const owner = ownerOf(form)
  openSection[owner] = isOpen(form, group) ? null : group.title
  openSub[owner] = null
}

function isSubOpen(form: SettingsDraft, group: FieldGroup, sub: Part): boolean {
  return isOpen(form, group) && openSub[ownerOf(form)] === sub.title
}

function toggleSub(form: SettingsDraft, group: FieldGroup, sub: Part) {
  openSub[ownerOf(form)] = isSubOpen(form, group, sub) ? null : sub.title
}

/** A sub-section with its fields */
interface Part {
  title: string
  fields: FieldSpec[]
}

/**
 * A section's fields split up: those in no sub-section (shown first), then
 * each sub-section with its fields (empty ones left out)
 */
function partsOf(group: FieldGroup): { loose: FieldSpec[]; subs: Part[] } {
  const subs = (group.subsections ?? [])
    .map((s) => ({ title: s.title, fields: group.fields.filter((f) => s.keys.includes(f.key)) }))
    .filter((s) => s.fields.length > 0)
  const inSub = new Set(subs.flatMap((s) => s.fields.map((f) => f.key)))
  return { loose: group.fields.filter((f) => !inSub.has(f.key)), subs }
}

/** Edited fields among `fields`, so a closed section still shows it holds changes */
function changesAmong(form: SettingsDraft, fields: FieldSpec[]): number {
  return fields.filter((f) => f.key in form.changes.value).length
}

function problemsAmong(form: SettingsDraft, fields: FieldSpec[]): boolean {
  return fields.some((f) => f.key in form.problems.value)
}

/** Opens the first section of `form` with a problem, and its sub-section, so it can be seen */
function openProblemSections(form: SettingsDraft, groups: FieldGroup[]) {
  const group = groups.find((g) => problemsAmong(form, g.fields))
  if (!group) return
  const owner = ownerOf(form)
  openSection[owner] = group.title
  openSub[owner] = partsOf(group).subs.find((s) => problemsAmong(form, s.fields))?.title ?? null
}

async function done() {
  if (saving.value) return
  // show the tab and section with the problem rather than silently refusing
  if (device.hasProblems.value) {
    openProblemSections(device, DEVICE_GROUPS)
    return void (tab.value = 'device')
  }
  if (shared.hasProblems.value) {
    openProblemSections(shared, SHARED_GROUPS)
    return void (tab.value = 'shared')
  }
  if (remote.hasProblems.value) {
    openProblemSections(remote, server.value?.groups ?? [])
    return void (tab.value = 'server')
  }

  saveError.value = null
  // which settings this Done changes, counted once all of them are saved
  // (after saving, the forms no longer see them as changes)
  const changedIds = TABS.flatMap((t) =>
    Object.keys(t.form.changes.value).map((key) => `${t.id}:${key}`),
  )
  /** "Lock after" changed: lock once everything is saved, so the new time starts with the next unlock */
  let relock = false
  // server settings first: if it refuses, nothing is applied on any tab
  if (serverChanges.value > 0 && server.value) {
    saving.value = true
    try {
      const changed = Object.keys(remote.changes.value)
      const values = await saveServerSettings(remote.changes.value)
      relock = changed.includes('lockAfterMinutes')
      server.value = { ...server.value, values }
      // stills keep their URL, so the browser would keep showing old ones
      if (changed.some((k) => k.startsWith('thumb') || k === 'scaleFlags')) bumpCacheVersion()
      // previews on screen load again, getting clips made with the new values
      // (the encoder count doesn't change the clips, so it doesn't count)
      const changesClips = (k: string) =>
        (/^(preview|folderPreview)/.test(k) && k !== 'previewMaxJobs') || k === 'scaleFlags'
      if (changed.some(changesClips)) previewGeneration.value++
    } catch (e) {
      tab.value = 'server'
      if (e instanceof SettingsRejected) {
        remote.setRemoteProblems(e.problems)
        openProblemSections(remote, server.value?.groups ?? [])
      }
      saveError.value = e instanceof Error ? e.message : 'Saving failed'
      return
    } finally {
      saving.value = false
    }
  }
  if (deviceChanges.value > 0 || sharedChanges.value > 0) {
    saving.value = true
    try {
      await applySettings({
        ...settings,
        ...device.changes.value,
        ...shared.changes.value,
      } as Settings)
    } catch (e) {
      // they already apply here; only saving them for the other devices failed
      tab.value = 'shared'
      saveError.value =
        (e instanceof Error ? e.message : 'Saving failed') +
        '. The changes apply on this device until it reloads.'
      return
    } finally {
      saving.value = false
    }
  }
  countUses(changedIds)
  // after applying: turning haptics on here already buzzes, off doesn't
  haptic('tap')
  emit('close')
  // the dialog closes first, so the lock animation shrinks the gallery alone.
  // Failing to reach the server leaves it unlocked: the old time still runs
  if (relock) void lockNow().catch(() => {})
}
</script>

<template>
  <ModalDialog title="Settings" wide :locked="saving" @close="emit('close')">
    <!-- Tabs -->
    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: tab === t.id }"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >
        {{ t.label }}
        <span v-if="t.form.hasProblems.value" class="badge bad">!</span>
        <span v-else-if="changesIn(t.form)" class="badge">{{ changesIn(t.form) }}</span>
      </button>
    </div>

    <p class="scope">
      <template v-if="tab === 'device'">
        Saved in this browser only: how the grid loads and plays previews depends on each
        screen and connection. Other phones and computers keep their own.
        <span class="screen-rate">
          This screen: {{ screenHz ? `${screenHz} Hz` : 'measuring…' }}
        </span>
      </template>
      <template v-else-if="tab === 'shared'">
        The same on every phone and computer: saved on the server, in
        config/shared-settings.json. Other devices get changes the next time they load the page.
      </template>
      <template v-else>
        Saved on the server, for every device. Stills, previews and storyboards made after a
        change use the new values; existing ones are rebuilt as they're viewed again, which
        takes a while for big folders.
      </template>
    </p>

    <form class="form" @submit.prevent="done">
      <template v-if="tab === 'server' && serverError">
        <div class="notice">
          <span>{{ serverError }}</span>
          <button type="button" class="button small" @click="loadServer">Retry</button>
        </div>
      </template>
      <p v-else-if="tab === 'server' && !server" class="notice">Loading…</p>

      <!-- The open tab's sections, each collapsible -->
      <template v-else>
      <!-- the settings changed most, from any tab, on top of every tab -->
      <section v-if="frequent.length" class="group frequent">
        <h3 class="group-heading">
          <button
            type="button"
            class="group-toggle"
            :aria-expanded="frequentOpen"
            @click="toggleFrequent"
          >
            <svg class="chevron" :class="{ open: frequentOpen }" viewBox="0 0 24 24" aria-hidden="true">
              <path :d="ICON_CHEVRON" />
            </svg>
            <span class="group-title">{{ FREQUENT_TITLE }}</span>
            <span v-if="frequentProblems" class="badge bad">!</span>
            <span v-else-if="frequentChanges" class="badge">{{ frequentChanges }}</span>
          </button>
        </h3>
        <div v-show="frequentOpen" class="group-body">
          <div
            v-for="item in frequent"
            :key="`${item.tab.id}:${item.field.key}`"
            class="frequent-item"
          >
            <!-- where it lives, if not on this tab -->
            <span v-if="item.tab.id !== tab" class="frequent-from">{{ item.tab.label }}</span>
            <SettingRow :field="item.field" :form="item.tab.form" id-suffix="frequent" />
          </div>
        </div>
      </section>

      <section v-for="group in activeGroups" :key="group.title" class="group">
        <h3 class="group-heading">
          <button
            type="button"
            class="group-toggle"
            :aria-expanded="isOpen(activeForm, group)"
            @click="toggleSection(activeForm, group)"
          >
            <svg
              class="chevron"
              :class="{ open: isOpen(activeForm, group) }"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path :d="ICON_CHEVRON" />
            </svg>
            <span class="group-title">{{ group.title }}</span>
            <span v-if="problemsAmong(activeForm, group.fields)" class="badge bad">!</span>
            <span v-else-if="changesAmong(activeForm, group.fields)" class="badge">
              {{ changesAmong(activeForm, group.fields) }}
            </span>
          </button>
        </h3>
        <div v-show="isOpen(activeForm, group)" class="group-body">
          <!-- fields in no sub-section, first -->
          <SettingRow
            v-for="field in partsOf(group).loose"
            :key="field.key"
            :field="field"
            :form="activeForm"
          />
          <!-- sub-sections, each collapsible; one open at a time -->
          <div v-for="sub in partsOf(group).subs" :key="sub.title" class="sub">
            <h4 class="group-heading">
              <button
                type="button"
                class="group-toggle sub-toggle"
                :aria-expanded="isSubOpen(activeForm, group, sub)"
                @click="toggleSub(activeForm, group, sub)"
              >
                <svg
                  class="chevron"
                  :class="{ open: isSubOpen(activeForm, group, sub) }"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path :d="ICON_CHEVRON" />
                </svg>
                <span class="sub-title">{{ sub.title }}</span>
                <span v-if="problemsAmong(activeForm, sub.fields)" class="badge bad">!</span>
                <span v-else-if="changesAmong(activeForm, sub.fields)" class="badge">
                  {{ changesAmong(activeForm, sub.fields) }}
                </span>
              </button>
            </h4>
            <div v-show="isSubOpen(activeForm, group, sub)" class="group-body sub-body">
              <SettingRow
                v-for="field in sub.fields"
                :key="field.key"
                :field="field"
                :form="activeForm"
              />
            </div>
          </div>
          <!-- Server → Caching: empties the whole cache, for every device -->
          <div v-if="tab === 'server' && group.title === CACHING_GROUP_TITLE" class="cache-action">
            <div class="cache-action-row">
              <div class="cache-action-text">
                <span class="cache-action-title">Clear all caches</span>
                <span class="cache-action-help">
                  Deletes every still, preview and storyboard on the server. Every device fetches
                  fresh ones; they're rebuilt as they're viewed again. Your files aren't touched.
                </span>
              </div>
              <button type="button" class="button small" :disabled="clearing" @click="clearAll">
                {{ clearing ? 'Clearing…' : 'Clear' }}
              </button>
            </div>
            <p
              v-if="clearResult"
              class="cache-action-result"
              :class="{ failed: clearResult.failed }"
              role="status"
            >
              {{ clearResult.text }}
            </p>
          </div>
        </div>
      </section>
      </template>

      <div class="actions">
        <p v-if="saveError" class="save-error">{{ saveError }}</p>
        <button
          type="button"
          class="button ghost"
          :disabled="activeForm.isDefault.value || saving || (tab === 'server' && !server)"
          :title="`${activeTab.label} settings`"
          @click="activeForm.resetToDefaults()"
        >
          Reset {{ activeTab.reset }} to defaults
        </button>
        <span class="spacer" />
        <button type="button" class="button" :disabled="saving" @click="emit('close')">
          Cancel
        </button>
        <!-- not disabled by problems: pressing it jumps to the tab that has them -->
        <button
          type="submit"
          class="button primary"
          :class="{ blocked: hasProblems }"
          :disabled="saving"
        >
          {{ saving ? 'Saving…' : changedCount > 0 ? `Done (${changedCount})` : 'Done' }}
        </button>
      </div>
    </form>
  </ModalDialog>
</template>

<style scoped>
/* ── Tabs ── */
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 0.8rem;
  background: rgba(0, 0, 0, 0.3);
}

.tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.5rem;
  border: none;
  border-radius: 0.6rem;
  background: none;
  color: #999;
  font-size: 0.85rem;
  cursor: pointer;
}

.tab:hover {
  color: #ddd;
}

.tab.active {
  background: rgba(255, 255, 255, 0.09);
  color: #fff;
}

/* the number (or "!") centered in its pill, both ways: a single digit in the
   min-width used to sit to the left */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-sizing: border-box;
  min-width: 1.1rem;
  height: 1.1rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  background: #2d6cdf;
  color: #fff;
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: center;
}

.badge.bad {
  background: #c0392b;
}

.scope {
  margin: 0;
  color: #8f88aa;
  font-size: 0.74rem;
  line-height: 1.45;
}

.screen-rate {
  display: block;
  margin-top: 0.2rem;
  color: #b4aec8;
}

/* ── Form ── */
.form {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.group-heading {
  margin: 0;
}

/* the whole header row opens / closes its section */
.group-toggle {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  padding: 0.45rem 0.5rem;
  border: none;
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.035);
  color: #8f88aa;
  text-align: left;
  cursor: pointer;
}

.group-toggle:hover {
  background: rgba(255, 255, 255, 0.07);
  color: #b4aec8;
}

.group-title {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* points right while closed, down while open */
.chevron {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  fill: currentColor;
  transform: rotate(-90deg);
  transition: transform 0.15s;
}

.chevron.open {
  transform: rotate(0deg);
}

.group-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* ── Frequently changed ── */
.frequent .group-toggle {
  /* stands out a little from the regular sections below it */
  background: color-mix(in srgb, var(--theme-purple) 10%, rgba(255, 255, 255, 0.035));
}

.frequent-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

/* the tab a setting from another tab lives on */
.frequent-from {
  align-self: flex-start;
  padding: 0 0.45rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #8f88aa;
  font-size: 0.65rem;
  line-height: 1.2rem;
}

/* ── Sub-sections: indented under their section, a quieter header ── */
.sub {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-left: 0.6rem;
  padding-left: 0.6rem;
  border-left: 1px solid var(--edge-soft);
}

.sub-toggle {
  padding: 0.35rem 0.5rem;
  background: rgba(255, 255, 255, 0.02);
}

.sub-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: #b4aec8;
}

.sub-body {
  padding-top: 0.1rem;
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0;
  padding: 1rem;
  border-radius: 0.7rem;
  background: rgba(255, 255, 255, 0.035);
  color: #999;
  font-size: 0.82rem;
}

/* ── Clear all caches (Server tab → Caching) ── */
.cache-action {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem;
  border: 1px solid var(--edge-soft);
  border-radius: 0.7rem;
  background: rgba(255, 255, 255, 0.035);
}

.cache-action-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.cache-action-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.cache-action-title {
  color: #ddd;
  font-size: 0.85rem;
  font-weight: 600;
}

.cache-action-help {
  color: #8f88aa;
  font-size: 0.74rem;
  line-height: 1.4;
}

.cache-action-result {
  margin: 0;
  color: #7fd6a0;
  font-size: 0.78rem;
}

.cache-action-result.failed {
  color: #f07060;
}

/* ── Buttons ── */
.actions {
  position: sticky;
  bottom: -1.1rem; /* the dialog's padding: sticks flush to its bottom edge */
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0 -1.1rem -1.1rem;
  padding: 0.8rem 1.1rem 1.1rem;
  background: rgba(22, 21, 28, 0.97);
  border-top: 1px solid var(--edge-soft);
}

.save-error {
  flex-basis: 100%;
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
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

.button.small {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
}

.button.ghost {
  border-color: transparent;
  background: none;
  box-shadow: none;
  color: #999;
  font-size: 0.8rem;
}

.button.ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}

.button.primary {
  border-color: #2d6cdf;
  background: #2d6cdf;
  color: #fff;
}

.button.primary:hover:not(:disabled) {
  background: #3b7bf0;
}

.button:disabled,
.button.blocked {
  opacity: 0.4;
  cursor: default;
}
</style>
