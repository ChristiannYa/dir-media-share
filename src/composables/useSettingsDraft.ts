import { computed, reactive } from 'vue'
import { settingProblem, type FieldGroup, type FieldSpec } from '@/settings'

/**
 * An editable copy of some settings for the Settings popup. Nothing is
 * applied here: the popup reads `changes` when Done is pressed.
 *
 * `current`: the values in use; `defaults`: what "Reset to defaults" restores.
 */
export function useSettingsDraft(
  groups: () => FieldGroup[],
  current: () => Record<string, unknown>,
  defaults: () => Record<string, unknown>,
) {
  const draft = reactive<Record<string, unknown>>({})
  /** What's typed in text / number fields, kept as text so half-typed values ("0.") survive */
  const text = reactive<Record<string, string>>({})
  /** Problems the server reported, until the field is edited again */
  const remoteProblems = reactive<Record<string, string>>({})

  const fields = computed(() => groups().flatMap((g) => g.fields))

  function fill(values: Record<string, unknown>) {
    for (const field of fields.value) {
      draft[field.key] = values[field.key]
      text[field.key] = String(values[field.key] ?? '')
    }
  }

  /** Starts over from the values in use */
  function load() {
    fill(current())
    for (const key of Object.keys(remoteProblems)) delete remoteProblems[key]
  }

  function onInput(field: FieldSpec, value: string) {
    text[field.key] = value
    delete remoteProblems[field.key]
    if (field.type === 'number') draft[field.key] = value.trim() === '' ? NaN : Number(value)
    else draft[field.key] = value.trim()
  }

  function setValue(field: FieldSpec, value: unknown) {
    delete remoteProblems[field.key]
    draft[field.key] = value
    text[field.key] = String(value)
  }

  const problems = computed(() => {
    const found: Record<string, string> = {}
    for (const field of fields.value) {
      const problem = remoteProblems[field.key] ?? settingProblem(field, draft[field.key])
      if (problem) found[field.key] = problem
    }
    return found
  })

  const hasProblems = computed(() => Object.keys(problems.value).length > 0)

  function isChanged(key: string): boolean {
    return draft[key] !== current()[key]
  }

  /** Only the values that differ from the ones in use */
  const changes = computed(() =>
    Object.fromEntries(
      fields.value.filter((f) => isChanged(f.key)).map((f) => [f.key, draft[f.key]]),
    ),
  )

  const isDefault = computed(() => fields.value.every((f) => draft[f.key] === defaults()[f.key]))

  /** Fills the form with the defaults; still applied only by Done */
  function resetToDefaults() {
    fill(defaults())
  }

  function setRemoteProblems(found: Record<string, string>) {
    Object.assign(remoteProblems, found)
  }

  load()

  return {
    draft,
    text,
    problems,
    hasProblems,
    changes,
    isDefault,
    isChanged,
    onInput,
    setValue,
    load,
    resetToDefaults,
    setRemoteProblems,
  }
}

export type SettingsDraft = ReturnType<typeof useSettingsDraft>
