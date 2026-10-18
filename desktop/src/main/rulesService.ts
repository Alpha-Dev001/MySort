/**
 * Rules service: validation + normalization on write, warnings on read,
 * pure resolution for rules:test. Database rules are re-validated on every use
 * (history and rules tables are user-writable; never trust stored paths).
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { appError } from '../shared/errors'
import type { FileRule, RuleInput, RuleTestResult } from '../shared/types'
import type { RuleRow, RulesRepo } from '../db/repositories/rulesRepo'
import type { Category } from '../shared/types'
import { normalizeExtensions, computeRuleWarnings, resolveRule, type RuleCandidate, type RuleContext } from '../engine/rules'
import { checkAbsoluteStructure } from '../engine/pathSafety'

export interface ResolvedRuleWrite {
  name: string
  extensions: string[]
  namePattern: string | null
  destination: { kind: 'relative' | 'absolute'; value: string }
  enabled: boolean
}

export class RulesService {
  constructor(
    private readonly repo: RulesRepo,
    private readonly getDestinationRoot: () => string,
    private readonly getCategoryDestinations: () => Partial<Record<Category, string>>
  ) {}

  toCandidate(row: RuleRow): RuleCandidate {
    return {
      id: row.id,
      name: row.name,
      extensions: row.extensions,
      namePattern: row.namePattern,
      destination: { kind: row.destinationKind, value: row.destination },
      enabled: row.enabled,
      position: row.position,
      createdAt: row.createdAt,
    }
  }

  ruleContext(): RuleContext {
    return {
      rules: this.repo.list().map((r) => this.toCandidate(r)),
      destinationRoot: this.getDestinationRoot(),
      categoryDestinations: this.getCategoryDestinations(),
    }
  }

  list(): FileRule[] {
    const candidates = this.repo.list().map((r) => this.toCandidate(r))
    const warnings = computeRuleWarnings(candidates, isDestinationAvailable, this.getDestinationRoot())
    return candidates.map((c) => ({
      id: c.id,
      name: c.name,
      extensions: c.extensions,
      namePattern: c.namePattern,
      destination: c.destination,
      enabled: c.enabled,
      position: c.position,
      warnings: warnings.get(c.id) ?? [],
      createdAt: c.createdAt,
      updatedAt: this.repo.get(c.id)?.updatedAt ?? c.createdAt,
    }))
  }

  create(input: ResolvedRuleWrite): RuleRow {
    this.validate(input)
    const row = this.repo.insert({
      id: randomUUID(),
      name: input.name,
      extensions: input.extensions,
      namePattern: input.namePattern,
      destination: input.destination.value,
      destinationKind: input.destination.kind,
      enabled: input.enabled,
    })
    return row
  }

  update(id: string, input: ResolvedRuleWrite): RuleRow {
    const existing = this.repo.get(id)
    if (!existing) throw appError('NOT_FOUND', 'rule not found')
    this.validate(input)
    return this.repo.update(id, {
      id,
      name: input.name,
      extensions: input.extensions,
      namePattern: input.namePattern,
      destination: input.destination.value,
      destinationKind: input.destination.kind,
      enabled: input.enabled,
    })
  }

  /** rules:test — pure, no disk access. */
  test(fileName: string): RuleTestResult {
    const ctx = this.ruleContext()
    const resolution = resolveRule(fileName, ctx)
    return {
      explanation: resolution.explanation,
      destination: resolution.destination,
      category: resolution.category,
    }
  }

  remove(id: string): void {
    if (!this.repo.get(id)) throw appError('NOT_FOUND', 'rule not found')
    this.repo.remove(id)
  }

  setEnabled(id: string, enabled: boolean): FileRule {
    if (!this.repo.get(id)) throw appError('NOT_FOUND', 'rule not found')
    this.repo.setEnabled(id, enabled)
    const rule = this.list().find((r) => r.id === id)
    if (!rule) throw appError('NOT_FOUND', 'rule not found')
    return rule
  }

  reorder(orderedIds: string[]): FileRule[] {
    this.repo.reorder(orderedIds)
    return this.list()
  }

  /** Inserts the friendly starter rules exactly once per profile. */
  seedOnce(seedRules: readonly { name: string; extensions: string[]; namePattern: string | null; destination: string }[]): void {
    if (this.repo.count() > 0) return
    for (const seed of seedRules) {
      this.repo.insert({
        id: randomUUID(),
        name: seed.name,
        extensions: seed.extensions,
        namePattern: seed.namePattern,
        destination: seed.destination,
        destinationKind: 'relative',
        enabled: true,
      })
    }
  }

  private validate(input: ResolvedRuleWrite): void {
    if (input.name.trim().length === 0) throw appError('VALIDATION_FAILED', 'a rule needs a name')
    if (input.extensions.length === 0 && !input.namePattern) {
      throw appError('VALIDATION_FAILED', 'a rule needs at least one extension or a filename pattern')
    }
    const normalized = normalizeExtensions(input.extensions)
    if (!normalized.ok) throw appError('VALIDATION_FAILED', normalized.message)
    input.extensions = normalized.extensions
    if (input.destination.kind === 'relative') {
      const value = input.destination.value.trim()
      if (value.length === 0) throw appError('VALIDATION_FAILED', 'the destination folder cannot be empty')
      const structural = checkAbsoluteRelative(value)
      if (!structural) {
        throw appError('PATH_INVALID', 'the relative destination contains characters or segments that are not allowed')
      }
      input.destination = { kind: 'relative', value }
    } else {
      const structural = checkAbsoluteStructure(input.destination.value)
      if (!structural.ok) throw appError(structural.code, structural.message)
    }
  }
}

/** Cheap availability probe used for warnings: the destination's root must exist. */
export function isDestinationAvailable(absoluteDestination: string): boolean {
  try {
    return existsSync(path.parse(absoluteDestination).root)
  } catch {
    return false
  }
}

function checkAbsoluteRelative(value: string): boolean {
  if (/^[\\/]/.test(value)) return false
  if (/^[A-Za-z]:/.test(value)) return false
  if (value.split(/[\\/]/).some((s) => s === '..' || s === '.')) return false
  if (/[<>:"|?*]/.test(value)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return false
  return true
}

/** Maps a RuleInput (already grant-resolved) into the service write shape. */
export function toResolvedWrite(input: RuleInput & { destination: { kind: 'relative' | 'absolute'; value: string } }): ResolvedRuleWrite {
  return {
    name: input.name,
    extensions: [...input.extensions],
    namePattern: input.namePattern && input.namePattern.length > 0 ? input.namePattern : null,
    destination: { ...input.destination },
    enabled: input.enabled,
  }
}
