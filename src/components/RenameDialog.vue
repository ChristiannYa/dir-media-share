<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModalDialog from '@/components/ModalDialog.vue'
import { renameEntry } from '@/api'

/** Popup asking for a new name for a file or folder, then renaming it */
const props = defineProps<{
  path: string
  /** Its current name, filled in to edit */
  name: string
  folder?: boolean
}>()
const emit = defineEmits<{ close: []; renamed: [path: string] }>()

const input = ref<HTMLInputElement | null>(null)
const newName = ref(props.name)
const saving = ref(false)
const error = ref<string | null>(null)

/** Caught here so the user sees it while typing; the server checks again */
const problem = computed(() =>
  /[/\\]/.test(newName.value) ? "A name can't contain / or \\" : null,
)
const canSave = computed(() => {
  const n = newName.value.trim()
  return n !== '' && n !== props.name && !problem.value && !saving.value
})

async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = null
  try {
    emit('renamed', await renameEntry(props.path, newName.value.trim()))
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'It could not be renamed'
    input.value?.focus()
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  const el = input.value
  if (!el) return
  el.focus()
  // files: select the name without its extension, like file managers do
  const dot = props.folder ? -1 : props.name.lastIndexOf('.')
  el.setSelectionRange(0, dot > 0 ? dot : props.name.length)
})
</script>

<template>
  <ModalDialog
    :title="folder ? 'Rename folder' : 'Rename'"
    :subtitle="name"
    :locked="saving"
    @close="emit('close')"
  >
    <form class="form" @submit.prevent="save">
      <input
        ref="input"
        v-model="newName"
        class="name-input"
        type="text"
        maxlength="255"
        autocomplete="off"
        enterkeyhint="done"
        :disabled="saving"
        @input="error = null"
      />
      <p v-if="problem ?? error" class="error">{{ problem ?? error }}</p>

      <div class="actions">
        <button type="button" class="button" :disabled="saving" @click="emit('close')">
          Cancel
        </button>
        <button type="submit" class="button primary" :disabled="!canSave">
          {{ saving ? 'Renaming…' : 'Rename' }}
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
