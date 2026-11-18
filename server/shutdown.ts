// Stopping the server: vite (dev mode) and this process.

import { rm } from 'node:fs/promises'
import { VITE_PID_FILE, VITE_PROCESS_PATTERN } from './consts/shutdown.ts'
import { run } from './run.ts'

/**
 * Called just before the server stops, by name (a reloaded file replaces its
 * own). Kept on globalThis, like the rest of the state that must outlive Vite
 * reloading server files. They must be quick and synchronous (e.g. killing
 * child processes): the process ends right after.
 */
const HOOKS_KEY = Symbol.for('med.shutdownHooks')
const store = globalThis as typeof globalThis & { [HOOKS_KEY]?: Map<string, () => void> }
const hooks = (store[HOOKS_KEY] ??= new Map())

export function onShutdown(name: string, hook: () => void) {
  hooks.set(name, hook)
}

/** Runs the shutdown hooks (once is enough; a second call finds nothing left to do) */
export function runShutdownHooks() {
  for (const [name, hook] of hooks) {
    try {
      hook()
    } catch (e) {
      console.error(`Shutdown step "${name}" failed:`, e)
    }
  }
}

/** Stops vite (dev mode) and this server; `reason` goes to the log */
export async function shutdownNow(reason: string): Promise<void> {
  console.log(`Shutting down (${reason})...`)
  runShutdownHooks()
  // kill vite by name: safe, no process group risks
  await run('pkill', ['-f', VITE_PROCESS_PATTERN]).catch(() => {})
  await rm(VITE_PID_FILE, { force: true })
  process.exit(0)
}
