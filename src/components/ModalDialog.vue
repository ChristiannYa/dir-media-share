<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { usePauseBackgroundWhileMounted } from '@/composables/useBackgroundPause'
import { useMarkPopupOpenWhileMounted } from '@/composables/usePopupOpen'

/**
 * Centered popup over a blurred, darkened page: every popup of the app
 * (Settings, the file / folder menus, the dialogs, the move picker) is one,
 * so they all look the same. Their look is .popup-backdrop / .popup-panel
 * (styles/tokens.css); how dark the page behind gets is Settings → Look →
 * Popup background darkness. Closes on Escape or a tap outside, unless
 * `locked` (e.g. while something is running).
 */
const props = defineProps<{
  title?: string
  /** Smaller line under the title */
  subtitle?: string
  locked?: boolean
  /** Roomier popup, for forms like Settings */
  wide?: boolean
  /** Roomier still, for showing a picture (the edit dialog) */
  large?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

function requestClose() {
  if (!props.locked) emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') requestClose()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// the backdrop blurs the whole screen: no need to keep the sky moving behind it
usePauseBackgroundWhileMounted()
// the top bar and the alphabet bar slide up out of the way while it's open
useMarkPopupOpenWhileMounted()
</script>

<template>
  <!-- rendered at the end of <body>: not clipped by the card, and taps inside
       don't reach the card (which would open it) -->
  <Teleport to="body">
    <Transition name="modal" appear>
      <div class="backdrop popup-backdrop" @click.self="requestClose">
        <div
          class="dialog popup-panel"
          :class="{ wide, large }"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <header v-if="title" class="header">
            <div class="titles">
              <h2 class="title">{{ title }}</h2>
              <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
            </div>
            <button
              class="close"
              aria-label="Close"
              :disabled="locked"
              @click="requestClose"
            >
              ✕
            </button>
          </header>
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  /* its color and blur: .popup-backdrop (tokens.css) */
}

/* its glass, border and shadow: .popup-panel (tokens.css) */
.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  width: min(24rem, 100%);
  max-height: 85dvh;
  padding: 1.1rem;
  overflow-y: auto;
  cursor: default;
}

.dialog.wide {
  width: min(34rem, 100%);
}

.dialog.large {
  width: min(56rem, 100%);
}

.header {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.titles {
  flex: 1;
  min-width: 0;
}

.title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle {
  margin: 0.15rem 0 0;
  color: #888;
  font-size: 0.75rem;
}

.close {
  flex: none;
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  color: #aaa;
  font-size: 0.85rem;
  cursor: pointer;
}

.close:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.close:disabled {
  opacity: 0.3;
  cursor: default;
}

/* ── Open / close animation ── */
.modal-enter-active,
.modal-leave-active {
  transition:
    opacity 0.18s ease,
    backdrop-filter 0.18s ease;
}

.modal-enter-active .dialog,
.modal-leave-active .dialog {
  transition: transform 0.18s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .dialog,
.modal-leave-to .dialog {
  transform: scale(0.95) translateY(8px);
}
</style>
