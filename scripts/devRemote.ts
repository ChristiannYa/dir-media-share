// `npm run dev:remote`: write code on this computer, run the app on the one
// that hosts it (where the media and config/data/ live).
//
// 1. Copies this project there with rsync (MED_HOST:MED_HOST_DIR)
// 2. Starts `npm run dev` there over SSH; its output shows here
// 3. Copies every saved change again, right away: Vite's hot reload there
//    picks it up, for the frontend and the server alike
// Ctrl+C stops the app there too.
//
// Never copied, and never deleted there: what git ignores (node_modules,
// dist…), .git/, .claude/, and config/ (the host's own settings and recorded
// data).
//
//   MED_HOST=christianya@10.0.0.12 npm run dev:remote
//   MED_HOST=… npm run dev:remote -- --dry-run   (lists what would be copied or deleted, then stops)
//
// The host needs an SSH server, and MED_PASSWORD (and MED_ROOT, the folder to
// share) set in its shell's startup file (e.g. ~/.zshrc): `npm run dev` there
// is started in a login shell, which reads it.

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'

/** SSH target of the host, e.g. christianya@10.0.0.12 */
const HOST = process.env.MED_HOST
/** The project's folder on the host (relative paths start at the home folder) */
const DIR = process.env.MED_HOST_DIR || 'Desktop/Websites/med'
/** Only list what a sync would do */
const DRY_RUN = process.argv.includes('--dry-run')
/** Saves that come close together (an editor writing several files) are copied together */
const DEBOUNCE_MS = 150

/** This project's folder */
const ROOT = path.resolve(import.meta.dirname, '..')

/** Top folders never copied (on top of what .gitignore lists) */
const SKIPPED = ['.git', '.claude', 'node_modules', 'dist', 'config']

if (!HOST) {
  console.error('❌ Set MED_HOST to the SSH target of the host, e.g. MED_HOST=christianya@10.0.0.12')
  process.exit(1)
}

/** Runs a command with its output here; resolves with its exit code */
function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', (error) => {
      console.error(`❌ ${command}: ${error.message}`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function rsyncArgs(): string[] {
  return [
    '-az',
    // files deleted here go there too (excluded ones are left alone)
    '--delete',
    ...(DRY_RUN ? ['--dry-run', '--itemize-changes'] : []),
    // whatever git ignores, in every folder
    '--filter=:- .gitignore',
    '--exclude=/.git/',
    // the host's own Claude Code settings
    '--exclude=/.claude/',
    // the host's own settings and recorded data (hearts, views, heatmaps)
    '--exclude=/config/',
    `${ROOT}/`,
    `${HOST}:${DIR}/`,
  ]
}

// ── Syncing, one at a time ──

let syncing: Promise<boolean> | null = null
/** A change came in during a sync: sync again once it's done */
let again = false

/** Copies the project to the host; false if rsync failed */
function sync(): Promise<boolean> {
  if (syncing) {
    again = true
    return syncing
  }
  syncing = (async () => {
    let ok = true
    do {
      again = false
      ok = (await run('rsync', rsyncArgs())) === 0
      if (!ok) console.error('❌ Copying to the host failed (see above)')
    } while (again)
    syncing = null
    return ok
  })()
  return syncing
}

// ── Start ──

console.log(`Copying ${ROOT} → ${HOST}:${DIR}`)
const copied = await sync()
if (DRY_RUN || !copied) process.exit(copied ? 0 : 1)

// copy each saved change
let timer: ReturnType<typeof setTimeout> | undefined
let changed = new Set<string>()

const watcher = watch(ROOT, { recursive: true }, (_event, file) => {
  if (!file) return
  const top = file.split(path.sep)[0] ?? ''
  if (SKIPPED.includes(top)) return
  changed.add(file)
  clearTimeout(timer)
  timer = setTimeout(() => {
    const files = [...changed]
    changed = new Set()
    void sync().then((ok) => {
      if (ok) console.log(`↻ copied: ${files.join(', ')}`)
    })
    if (files.some((f) => f === 'package.json' || f === 'package-lock.json')) {
      console.log('⚠ The dependencies changed: restart to install them on the host')
    }
    if (files.some((f) => f.startsWith('vite.config') || f === path.join('server', 'vitePlugin.ts'))) {
      console.log('⚠ The Vite setup changed: restart to apply it')
    }
  }, DEBOUNCE_MS)
})

// in a login shell, so the host's MED_PASSWORD / MED_ROOT are set; --host so
// the app answers on the network, not only on the host itself
const remote = `cd '${DIR}' && npm install --no-audit --no-fund && npm run dev -- --host`
console.log(`Starting the app on ${HOST}…`)

// Ctrl+C reaches the app there through SSH's terminal; this one waits for it to stop
process.on('SIGINT', () => {})
const code = await run('ssh', ['-t', HOST, `exec $SHELL -lic ${JSON.stringify(remote)}`])
watcher.close()
clearTimeout(timer)
process.exit(code)
