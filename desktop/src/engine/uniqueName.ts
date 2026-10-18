/**
 * Deterministic never-overwrite conflict naming:
 * report.pdf -> report.pdf, report (1).pdf, ... report (999).pdf, then 8-hex names.
 *
 * The executor pairs the generator with the atomic link/exclusive-copy step, so
 * name checking and claiming are one call and two operations cannot both win.
 */

import { randomBytes } from 'node:crypto'
import { sanitizeDestName } from './pathSafety'

/** Split into base and extension, where the extension is the whole suffix after the first dot. */
export function splitDisplayName(fileName: string): { base: string; ext: string } {
  const clean = sanitizeDestName(fileName)
  const dot = clean.indexOf('.', 1)
  if (dot > 0) return { base: clean.slice(0, dot), ext: clean.slice(dot) }
  return { base: clean, ext: '' }
}

export function* uniqueNameSequence(fileName: string): Generator<string> {
  const { base, ext } = splitDisplayName(fileName)
  yield `${base}${ext}`
  for (let i = 1; i <= 999; i++) yield `${base} (${i})${ext}`
  for (;;) yield `${base} (${randomBytes(4).toString('hex')})${ext}`
}

export interface UniqueNameChoice {
  name: string
  /** true when the original name was taken and a numbered name is used. */
  renamed: boolean
}

/**
 * Plan-time (non-atomic) conflict resolution against a read-only existence check.
 * Execution still claims the name atomically; this only powers the preview.
 */
export async function planUniqueName(
  fileName: string,
  exists: (name: string) => Promise<boolean>
): Promise<UniqueNameChoice> {
  const gen = uniqueNameSequence(fileName)
  for (let i = 0; i < 1000; i++) {
    const name = gen.next().value as string
    if (!(await exists(name))) return { name, renamed: i > 0 }
  }
  const name = gen.next().value as string
  return { name, renamed: true }
}
