import { spawn } from 'node:child_process'

export interface RunResult {
  /** Exit code; null if the process was killed by a signal */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs a program to completion. Rejects if it can't be started (e.g. not
 * installed), or if `signal` aborts: the program is then killed. `onStdout`
 * sees the output as it comes (e.g. ffmpeg's -progress lines).
 */
export function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      onStdout?.(chunk.toString())
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    )
  })
}
