/**
 * Deterministic rule engine. Custom rules (user order, first match wins) beat
 * built-in defaults. Every result carries a human-readable explanation.
 * Pure: no disk access, no I/O.
 */

import path from 'node:path'
import { appError } from '../shared/errors'
import type { Category, RuleExplanation, RuleWarning } from '../shared/types'
import { candidateSuffixes, classifyFileName, normalizeExtension } from './classify'
import { CATEGORY_LABELS } from './defaultRules'
import { checkAbsoluteStructure, checkRelativeStructure, normalizePath } from './pathSafety'

export interface RuleCandidate {
  id: string
  name: string
  extensions: string[] // normalized, lowercase, no leading dots
  namePattern: string | null
  destination: { kind: 'relative' | 'absolute'; value: string }
  enabled: boolean
  position: number
  createdAt: string
}

export interface RuleContext {
  rules: RuleCandidate[]
  destinationRoot: string
  categoryDestinations: Partial<Record<Category, string>>
}

export interface RuleResolution {
  outcome: 'custom' | 'default' | 'no_action' | 'error'
  category: Category | null
  ruleKind: 'custom' | 'default' | 'none'
  ruleId: string | null
  ruleLabel: string
  /** Absolute destination FOLDER, before path-safety validation. Not a file path:
   *  callers supply the file name separately and join it under this folder. */
  destination: string | null
  destinationKind: 'relative' | 'absolute' | null
  explanation: RuleExplanation
  error?: ReturnType<typeof appError>
}

export function sortRules(rules: RuleCandidate[]): RuleCandidate[] {
  return [...rules].sort(
    (a, b) =>
      a.position - b.position ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  )
}

/** Wildcard pattern ('*' and '?') to anchored, case-insensitive regex. */
export function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

export function matchesRule(
  rule: Pick<RuleCandidate, 'extensions' | 'namePattern'>,
  fileName: string,
  suffixes: string[]
): { matched: boolean; byExtension: string | null; byPattern: boolean } {
  const lower = fileName.toLowerCase()
  const byExt = suffixes.find((s) => rule.extensions.includes(s)) ?? null
  const byPattern = rule.namePattern
    ? patternToRegExp(rule.namePattern).test(lower)
    : false
  return { matched: byExt !== null || byPattern, byExtension: byExt, byPattern }
}

export function resolveRuleDestination(
  destination: { kind: 'relative' | 'absolute'; value: string },
  destinationRoot: string
): { ok: true; path: string } | { ok: false; message: string } {
  if (destination.kind === 'relative') {
    const check = checkRelativeStructure(destination.value)
    if (!check.ok) return { ok: false, message: check.message }
    return { ok: true, path: normalizePath(path.resolve(destinationRoot, destination.value.replace(/\//g, '\\'))) }
  }
  const check = checkAbsoluteStructure(destination.value)
  if (!check.ok) return { ok: false, message: check.message }
  return { ok: true, path: normalizePath(destination.value) }
}

function defaultDestination(category: Category, ctx: RuleContext): string {
  const override = ctx.categoryDestinations[category]
  if (override) return normalizePath(override)
  return normalizePath(path.resolve(ctx.destinationRoot, CATEGORY_LABELS[category]))
}

/** The rule engine's single source of truth for "where does this file go". */
export function resolveRule(fileName: string, ctx: RuleContext): RuleResolution {
  const suffixes = candidateSuffixes(fileName)
  const defaultCat = classifyFileName(fileName)

  if (suffixes.length === 0) {
    return {
      outcome: 'no_action',
      category: null,
      ruleKind: 'none',
      ruleId: null,
      ruleLabel: '',
      destination: null,
      destinationKind: null,
      explanation: {
        outcome: 'no_action',
        summary: `"${fileName}" has no extension, so MySort cannot classify it. It was left alone.`,
        considered: [],
      },
    }
  }

  const ordered = sortRules(ctx.rules)
  const considered: RuleExplanation['considered'] = []
  let winner: RuleCandidate | null = null
  let winnerMatch: { byExtension: string | null; byPattern: boolean } | null = null
  const shadowedBy: string[] = []

  for (const rule of ordered) {
    const m = matchesRule(rule, fileName, suffixes)
    if (!rule.enabled) {
      considered.push({ ruleId: rule.id, name: rule.name, result: 'disabled' })
      continue
    }
    if (!m.matched) {
      considered.push({ ruleId: rule.id, name: rule.name, result: 'no_match' })
      continue
    }
    if (winner) {
      considered.push({ ruleId: rule.id, name: rule.name, result: 'shadowed' })
      shadowedBy.push(`'${rule.name}' (position ${rule.position})`)
      continue
    }
    winner = rule
    winnerMatch = { byExtension: m.byExtension, byPattern: m.byPattern }
    considered.push({ ruleId: rule.id, name: rule.name, result: 'won' })
  }

  const defaultNote = `Default would have used ${CATEGORY_LABELS[defaultCat.category ?? 'other']}.`

  if (winner) {
    const resolved = resolveRuleDestination(winner.destination, ctx.destinationRoot)
    if (!resolved.ok) {
      const entry = considered.find((c) => c.ruleId === winner?.id)
      if (entry) entry.result = 'invalid'
      return {
        outcome: 'error',
        category: defaultCat.category,
        ruleKind: 'custom',
        ruleId: winner.id,
        ruleLabel: winner.name,
        destination: null,
        destinationKind: winner.destination.kind,
        explanation: {
          outcome: 'error',
          summary: `Rule '${winner.name}' matched but its destination is invalid (${resolved.message}). The file was not assigned anywhere.`,
          considered,
        },
        error: appError('RULE_INVALID', `rule '${winner.name}': ${resolved.message}`, {
          ruleId: winner.id,
        }),
      }
    }

    const matchedBy = winnerMatch?.byExtension
      ? `.${winnerMatch.byExtension}`
      : `the filename pattern '${winner.namePattern ?? ''}'`
    const parts = [
      `Matched custom rule '${winner.name}' (position ${winner.position}) by ${matchedBy}.`,
      shadowedBy.length > 0 ? `Also matches ${shadowedBy.join(', ')}, lower in the list.` : '',
      defaultNote,
    ]
    return {
      outcome: 'custom',
      category: defaultCat.category,
      ruleKind: 'custom',
      ruleId: winner.id,
      ruleLabel: winner.name,
      destination: resolved.path,
      destinationKind: winner.destination.kind,
      explanation: { outcome: 'custom', summary: parts.filter(Boolean).join(' '), considered },
    }
  }

  const category = defaultCat.category ?? 'other'
  const dest = defaultDestination(category, ctx)
  const suffixText = defaultCat.matchedSuffix ? `.${defaultCat.matchedSuffix}` : 'this extension'
  return {
    outcome: 'default',
    category,
    ruleKind: 'default',
    ruleId: null,
    ruleLabel: CATEGORY_LABELS[category],
    destination: dest,
    destinationKind: 'relative',
    explanation: {
      outcome: 'default',
      summary: `No custom rule matched. ${suffixText} belongs to ${CATEGORY_LABELS[category]}, so the file goes to ${dest}.`,
      considered,
    },
  }
}

/**
 * Warnings for the rules screen: overlaps, shadowed rules, unavailable destinations.
 * `isAvailable` is injected so this stays pure.
 */
export function computeRuleWarnings(
  rules: RuleCandidate[],
  isAvailable: (absoluteDestination: string) => boolean,
  destinationRoot: string
): Map<string, RuleWarning[]> {
  const out = new Map<string, RuleWarning[]>()
  const ordered = sortRules(rules)
  for (let i = 0; i < ordered.length; i++) {
    const rule = ordered[i]
    const warnings: RuleWarning[] = []
    if (!rule.enabled) {
      out.set(rule.id, warnings)
      continue
    }
    const resolved = resolveRuleDestination(rule.destination, destinationRoot)
    if (resolved.ok && !isAvailable(resolved.path)) {
      warnings.push({ code: 'DEST_UNAVAILABLE' })
    }
    // Overlap: share an extension with another enabled rule.
    for (let j = 0; j < ordered.length; j++) {
      if (i === j) continue
      const other = ordered[j]
      if (!other.enabled) continue
      const shared = rule.extensions.filter((e) => other.extensions.includes(e))
      if (shared.length > 0) {
        const earlier = j < i
        warnings.push({
          code: 'OVERLAPS',
          otherRuleId: other.id,
          otherRuleName: other.name,
        })
        if (!earlier) break // report only the first overlap; UI explains ordering
      }
    }
    // Shadowed: every criterion is covered by strictly earlier enabled rules.
    const earlierRules = ordered.slice(0, i).filter((r) => r.enabled)
    const allExtsCovered = rule.extensions.every((e) =>
      earlierRules.some((r) => r.extensions.includes(e))
    )
    const patternCovered = rule.namePattern
      ? earlierRules.some((r) => r.namePattern === rule.namePattern)
      : true
    if (
      earlierRules.length > 0 &&
      (rule.extensions.length > 0 || rule.namePattern) &&
      allExtsCovered &&
      patternCovered &&
      earlierRules.some((r) => rule.extensions.every((e) => r.extensions.includes(e)))
    ) {
      const blocker = earlierRules.find((r) => rule.extensions.every((e) => r.extensions.includes(e)))
      warnings.push({ code: 'SHADOWED', otherRuleId: blocker?.id, otherRuleName: blocker?.name })
    }
    out.set(rule.id, warnings)
  }
  return out
}

/** Normalize + validate extensions the way the rules service stores them. */
export function normalizeExtensions(raw: string[]): { ok: true; extensions: string[] } | { ok: false; message: string } {
  const out: string[] = []
  for (const item of raw) {
    const n = normalizeExtension(item)
    if (!n.ok) return { ok: false, message: `"${item}": ${n.reason}` }
    if (!out.includes(n.ext)) out.push(n.ext)
  }
  return { ok: true, extensions: out }
}
