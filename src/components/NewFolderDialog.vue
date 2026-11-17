<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { createFolder } from '@/api'

/** Popup asking for a name, then creating that folder inside `dir` */
const props = defineProps<{
  /** Folder to create it in */
  dir: string
  folderName: string
}>()
/** `created`: where the new folder is */
const emit = defineEmits<{ close: []; created: [path: string] }>()

const input = ref<HTMLInputElement | null>(null)
const name = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

/** Caught here so the user sees it while typing; the server checks again */
const problem = computed(() => (/[/\\]/.test(name.value) ? "A name can't contain / or \\" : null))
const canSave = computed(() => name.value.trim() !== '' && !problem.value && !saving.value)

async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = null
  try {
    emit('created', await createFolder(props.dir, name.value.trim()))
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'The folder could not be created'
    input.value?.focus()
  } finally {
    saving.value = false
  }
}

/**
 * Folder names are lowercase: whatever is typed or pasted is lowercased as it
 * comes, keeping the cursor where it was. Not mid-composition (a keyboard
 * building a character, e.g. accents or Japanese): once it's done
 */
function onInput(e: Event) {
  if ((e as InputEvent).isComposing) return
  const el = e.target as HTMLInputElement
  const lower = el.value.toLowerCase()
  if (lower !== el.value) {
    const { selectionStart, selectionEnd } = el
    el.value = lower
    el.setSelectionRange(selectionStart, selectionEnd)
  }
  name.value = lower
  error.value = null
}

onMounted(() => input.value?.focus())
</script>

<template>
  <ModalDialog
    title="New folder"
    :subtitle="`Inside ${folderName}`"
    :locked="saving"
    @close="emit('close')"
  >
    <form class="form" @submit.prevent="save">
      <input
        ref="input"
        :value="name"
        class="name-input"
        type="text"
        placeholder="folder name"
        maxlength="255"
        autocomplete="off"
        autocapitalize="none"
        enterkeyhint="done"
        :disabled="saving"
        @input="onInput"
        @compositionend="onInput"
      />
      <p v-if="problem ?? error" class="error">{{ problem ?? error }}</p>

      <div class="actions">
        <button type="button" class="button" :disabled="saving" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="button primary" :disabled="!canSave">
          {{ saving ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </form>
  </ModalDialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.name-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--edge);
  border-radius: 0.7rem;
  background: rgba(0, 0, 0, 0.35);
  color: #eee;
  /* 16px+: iOS zooms the page into smaller inputs */
  font-size: 1rem;
  outline: none;
  transition: border-color 0.12s;
}

.name-input:focus {
  border-color: #2d6cdf;
}

.error {
  margin: 0;
  color: #f07060;
  font-size: 0.78rem;
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

.button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
