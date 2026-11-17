<script setup lang="ts">
import { onMounted, ref } from 'vue'
import App from '@/App.vue'
import LockScreen from '@/components/LockScreen.vue'
import NightSky from '@/components/NightSky.vue'
import { fetchSession } from '@/api'
import { lockState, startLockTimer } from '@/composables/useLock'
import { poweredOff } from '@/composables/usePowerOff'

/**
 * The lock screen until the passcode is accepted, then the gallery. App isn't
 * mounted before that: its first requests (listing, job events, shared
 * settings) need the login cookie.
 *
 * Unlocking plays the iOS unlock: the lock screen swells a little and fades
 * away while the gallery, starting smaller behind it, scales up to fill the
 * screen. Already logged in when the page loads: the gallery just shows.
 * Locking (useLock's lockNow) plays the same in reverse.
 */

/** The gallery is playing its zoom-in (only right after unlocking) */
const zoomingIn = ref(false)

onMounted(async () => {
  try {
    const s = await fetchSession()
    lockState.value = s.unlocked ? 'unlocked' : 'locked'
    if (s.unlocked) startLockTimer(s.remainingMs)
  } catch {
    lockState.value = 'locked'
  }
})

/** `remainingMs`: until the app locks by itself (null = never) */
function onUnlocked(remainingMs: number | null) {
  startLockTimer(remainingMs)
  zoomingIn.value = true
  lockState.value = 'unlocked'
}
</script>

<template>
  <!-- the zoom's transform is removed when it ends: while set, it would make
       the gallery's fixed parts (sky, bars) move with the page -->
  <div
    v-if="lockState === 'unlocked'"
    class="app-layer"
    :class="{ 'zoom-in': zoomingIn }"
    @animationend.self="zoomingIn = false"
  >
    <App />
  </div>

  <Transition name="unlock">
    <div v-if="lockState !== 'unlocked'" class="locked">
      <NightSky />
      <LockScreen v-if="lockState === 'locked'" @unlocked="onUnlocked" />
    </div>
  </Transition>

  <!-- shutdown: black screen over everything (usePowerOff) -->
  <div v-if="poweredOff" class="powered-off" />
</template>

<style scoped>
/* On top of the gallery, so the gallery can grow in behind it while it fades */
.locked {
  position: fixed;
  inset: 0;
  z-index: 100;
  overflow-y: auto;
  isolation: isolate; /* keeps the sky canvas behind, like .gallery in App.vue */
  background: var(--page-bg);
}

/* ── Unlock ── */
/* the lock screen swells and fades, as if passing through it */
.unlock-leave-active {
  transition:
    transform 0.55s cubic-bezier(0.3, 0, 0.2, 1),
    opacity 0.45s ease-out;
}

.unlock-leave-to {
  transform: scale(1.12);
  opacity: 0;
}

/* the gallery comes up from smaller to the full screen, scaled around the
   middle of the screen (not of the whole page) */
.app-layer.zoom-in {
  transform-origin: 50% 50vh;
  animation: zoom-in 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes zoom-in {
  from {
    transform: scale(0.8);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

/* ── Shutdown ── */
.powered-off {
  position: fixed;
  inset: 0;
  z-index: 1000; /* above the lock screen (100) and any dialog */
  background: #000;
  cursor: none;
}

/* the afterglow: the dot the picture shrank into lingers, then fades */
.powered-off::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 14px 5px rgba(255, 255, 255, 0.75);
  /* starts when the collapse ends (tv-off's duration) */
  animation: afterglow 0.8s ease-out 0.65s both;
}

@keyframes afterglow {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .powered-off::after {
    display: none;
  }

  .unlock-leave-active {
    transition: opacity 0.2s;
  }

  .unlock-leave-to {
    transform: none;
  }

  .app-layer.zoom-in {
    animation: none;
  }
}
</style>

<style>
/* ── Lock: the unlock in reverse (view transition, see useLock's lockNow) ──
   Not scoped: these pseudo-elements belong to the whole page. A picture of
   the gallery shrinks and fades while the lock screen, on top, settles in
   from slightly bigger */
html.locking::view-transition {
  background: var(--page-bg);
}

html.locking::view-transition-old(root) {
  animation: lock-gallery-out 0.55s cubic-bezier(0.3, 0, 0.2, 1) both;
}

html.locking::view-transition-new(root) {
  animation: lock-screen-in 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes lock-gallery-out {
  to {
    transform: scale(0.8);
    opacity: 0;
  }
}

@keyframes lock-screen-in {
  from {
    transform: scale(1.12);
    opacity: 0;
  }
}

/* ── Shutdown: an old TV turning off (view transition, see usePowerOff) ──
   A picture of the screen collapses to a bright line through the middle,
   then to a dot; the black screen is behind it */
html.powering-off::view-transition {
  background: #000;
}

html.powering-off::view-transition-old(root) {
  /* the picture's own center = the middle of the viewport */
  animation: tv-off 0.65s both;
}

/* the black screen: the backdrop already shows it */
html.powering-off::view-transition-new(root) {
  animation: none;
  opacity: 0;
}

@keyframes tv-off {
  0% {
    transform: scale(1, 1);
    filter: brightness(1);
    animation-timing-function: cubic-bezier(0.6, 0, 0.9, 0.4);
  }
  55% {
    /* a thin line across the screen, glowing */
    transform: scale(1, 0.004);
    filter: brightness(3);
    animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.5);
  }
  100% {
    /* the line shrinks to a dot */
    transform: scale(0, 0.004);
    filter: brightness(5);
  }
}
</style>
