// Stopping the server: vite (dev mode) and this process.

import { rm } from 'node:fs/promises'
import { VITE_PID_FILE, VITE_PROCESS_PATTERN } from './consts/shutdown.ts'
import { run } from './run.ts'

/** Stops vite (dev mode) and this server; `reason` goes to the log */
export async function shutdownNow(reason: string): Promise<void> {
  console.log(`Shutting down (${reason})...`)
  // kill vite by name: safe, no process group risks
  await run('pkill', ['-f', VITE_PROCESS_PATTERN]).catch(() => {})
  await rm(VITE_PID_FILE, { force: true })
  process.exit(0)
}
