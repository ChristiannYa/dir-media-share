// Turning client-supplied paths into safe paths inside the shared folder.

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { SHARE_ROOT_ENV } from './consts/server.ts'

/**
 * The shared folder: MED_ROOT if set, otherwise the folder the command was
 * started in (npm runs scripts from the project folder, but keeps the
 * original one in INIT_CWD).
 */
export const SHARE_ROOT = path.resolve(
  process.env[SHARE_ROOT_ENV] ?? process.env.INIT_CWD ?? process.cwd(),
)

let canonicalRoot: Promise<string> | null = null

/** The shared folder with symlinks resolved */
export function baseDir(): Promise<string> {
  canonicalRoot ??= realpath(SHARE_ROOT)
  return canonicalRoot
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep)
}

/**
 * Resolves a client path to a real path inside the shared folder.
 * `null` if it doesn't exist or points outside (blocks `../` tricks).
 */
export async function resolve(rel: string): Promise<string | null> {
  const base = await baseDir()
  try {
    const full = await realpath(path.join(base, rel))
    return isInside(full, base) ? full : null
  } catch {
    return null
  }
}

/** Path of `full` relative to the shared folder, with "/" separators (what the client uses) */
export async function relativePath(full: string): Promise<string> {
  return path.relative(await baseDir(), full).split(path.sep).join('/')
}

/** Like `resolve`, but only for regular files */
export async function resolveFile(rel: string): Promise<string | null> {
  const full = await resolve(rel)
  if (!full) return null
  const info = await stat(full).catch(() => null)
  return info?.isFile() ? full : null
}

/** Like `resolve`, but only for folders */
export async function resolveDir(rel: string): Promise<string | null> {
  const full = await resolve(rel)
  if (!full) return null
  const info = await stat(full).catch(() => null)
  return info?.isDirectory() ? full : null
}
