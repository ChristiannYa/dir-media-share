// What the shutdown button stops, and when the server stops by itself.

/** `pkill -f` pattern that matches the vite dev server (started by `meddev` as `vite --host`) */
export const VITE_PROCESS_PATTERN = 'vite --host'
/** PID file written by older start scripts; removed on shutdown if it exists */
export const VITE_PID_FILE = '/tmp/meddev-vite.pid'
/**
 * Default of Settings → Server → Shutdown → Shut down when idle: minutes
 * without any activity (no request from any device, none still running)
 * after which the server stops by itself, like the shutdown button. 0 = never
 */
export const IDLE_SHUTDOWN_MINUTES = 60
/** How often the idle time is checked (ms) */
export const IDLE_CHECK_MS = 30_000
