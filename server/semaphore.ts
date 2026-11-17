/** A task waiting its turn */
interface Waiter {
  start: () => void
  /** Told its place in line (1 = next) whenever it changes */
  onPosition?: (position: number) => void
}

/**
 * Limits how many tasks run at the same time; the rest wait their turn.
 * `limit` is a getter, read every time a task starts or ends, so changing
 * the setting behind it applies without a restart.
 */
export class Semaphore {
  private readonly limit: () => number
  private running = 0
  private readonly waiting: Waiter[] = []

  constructor(limit: number | (() => number)) {
    this.limit = typeof limit === 'number' ? () => limit : limit
  }

  /**
   * Runs `task` once there's room. If `signal` aborts while it's still
   * waiting, it leaves the line and rejects with the signal's reason (the
   * task then never runs). While it waits, `onPosition` is told its place in
   * line (1 = next) each time that changes.
   */
  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    onPosition?: (position: number) => void,
  ): Promise<T> {
    await this.acquire(signal, onPosition)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(signal?: AbortSignal, onPosition?: (position: number) => void): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const waiter: Waiter = { start: () => {}, onPosition }
    const ready = new Promise<void>((resolve, reject) => {
      const leave = () => {
        const i = this.waiting.indexOf(waiter)
        if (i < 0) return // already started
        this.waiting.splice(i, 1)
        this.announce(i)
        reject(signal?.reason)
      }
      waiter.start = () => {
        signal?.removeEventListener('abort', leave)
        resolve()
      }
      signal?.addEventListener('abort', leave, { once: true })
      this.waiting.push(waiter)
    })
    this.startWaiting()
    // has to wait: tell it its place (the others didn't move)
    const i = this.waiting.indexOf(waiter)
    if (i >= 0) onPosition?.(i + 1)
    return ready
  }

  private release() {
    this.running--
    this.startWaiting()
  }

  /** Starts waiting tasks while there's room (the limit may have gone up) */
  private startWaiting() {
    let started = 0
    while (this.running < Math.max(1, this.limit()) && this.waiting.length > 0) {
      this.running++
      started++
      this.waiting.shift()?.start()
    }
    if (started > 0) this.announce(0)
  }

  /** Tells the tasks from index `from` on their new place in line */
  private announce(from: number) {
    for (let i = from; i < this.waiting.length; i++) this.waiting[i]?.onPosition?.(i + 1)
  }
}
