/**
 * Planner: builds an OrganizationPlan from a read-only file-system view.
 * Used by preview; auto mode uses the same resolution helpers, so preview and
 * execution can never disagree about where a file goes.
 *
 * The planner receives only an FsReader — it cannot write or move anything.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { candidateSuffixes } from './classify'
import { resolveRule, sortRules, patternToRegExp, resolveRuleDestination, type RuleContext } from './rules'
import {
  checkNameEligibility,
  checkStatEligibility,
  isDangerousDirName,
  isInside,
  pathsEqual,
  sameVolume,
  validateDestination,
  type DestinationContext,
} from './pathSafety'
import { planUniqueName } from './uniqueName'
import type { FsReader } from './fs'
import type { OrganizationPlan, PlanWarning, RuleExplanation } from '../shared/types'
import { normalizePath } from './pathSafety'

export interface PlanRequest {
  folderId: number
  folderPath: string
  rules: RuleContext
  destinationContext: DestinationContext
}

export async function buildPlan(reader: FsReader, req: PlanRequest): Promise<OrganizationPlan> {
  const entries = (await reader.readdir(req.folderPath))
    .map((n) => path.join(req.folderPath, n))
    .sort((a, b) => a.localeCompare(b))

  const plan: OrganizationPlan = {
    planId: randomUUID(),
    folderId: req.folderId,
    folderPath: req.folderPath,
    createdAt: new Date().toISOString(),
    items: [],
    skipped: [],
  }

  const skip = (fileName: string, reason: string): void => {
    plan.skipped.push({ fileName, reason })
  }

  for (const full of entries) {
    const fileName = path.basename(full)

    // A file already sitting under the destination root has nothing to do — but
    // only when it is in a subfolder of the destination root. Files sitting
    // directly in the destination root are still unsorted downloads (the
    // combined "watch and sort into the same folder" setup) and must be
    // processed. Only files already moved into a category subfolder are skipped.
    const candidateDir = normalizePath(path.dirname(full))
    const destRoot = normalizePath(req.destinationContext.destinationRoot)
    if (isInside(full, destRoot) && candidateDir !== destRoot) {
      continue
    }
    if (pathsEqual(full, destRoot)) {
      continue
    }

    const nameCheck = checkNameEligibility(fileName)
    if (!nameCheck.eligible) {
      if (nameCheck.reason === 'TEMP_FILE' || nameCheck.reason === 'EXCLUDED') {
        skip(fileName, nameCheck.reason)
      }
      continue
    }

    let stat
    try {
      stat = await reader.lstat(full)
    } catch {
      continue
    }

    const statCheck = checkStatEligibility(stat)
    if (!statCheck.eligible) {
      if (statCheck.reason === 'ZERO_SIZE') skip(fileName, 'NOT_READY')
      continue
    }

    const isDir = stat.isDirectory && !stat.isSymlink

    if (isDir) {
      if (!req.destinationContext.sortFolders) continue
      if (isDangerousDirName(fileName)) continue
      if ((req.destinationContext.destinationSubfolders ?? []).includes(fileName)) continue
      // Never move a folder that contains the destination root.
      if (isInside(req.destinationContext.destinationRoot, full)) continue
    }

    // Nothing to classify without an extension; the file stays where it is.
    // Folders are classified by name pattern or the Folders bucket instead.
    if (!isDir && candidateSuffixes(fileName).length === 0) {
      skip(fileName, 'NO_EXTENSION')
      continue
    }

    // Resolve destination.
    let finalDest: string | null = null
    let explanation: RuleExplanation = { outcome: 'default', summary: '', considered: [] }

    if (isDir) {
      const ctx = req.rules
      const ordered = sortRules(ctx.rules)
      let matched = false
      for (const rule of ordered) {
        if (!rule.enabled || !rule.namePattern) continue
        if (!patternToRegExp(rule.namePattern).test(fileName.toLowerCase())) continue
        const r = resolveRuleDestination(rule.destination, ctx.destinationRoot)
        if (r.ok) {
          finalDest = r.path
          explanation = { outcome: 'custom', summary: `Matched custom rule '${rule.name}' by filename pattern.`, considered: [] }
          matched = true
          break
        }
      }
      if (!matched) {
        finalDest = normalizePath(path.join(ctx.destinationRoot, 'Folders'))
        explanation = { outcome: 'default', summary: 'Top-level folder sorted into the Folders bucket.', considered: [] }
      }
    } else {
      const resolution = resolveRule(fileName, req.rules)
      if (resolution.outcome === 'no_action') {
        skip(fileName, 'NO_EXTENSION')
        continue
      }
      if (resolution.outcome === 'error' || !resolution.destination) {
        skip(fileName, resolution.error?.code ?? 'RULE_INVALID')
        continue
      }
      finalDest = resolution.destination
      explanation = resolution.explanation
    }

    if (!finalDest) {
      skip(fileName, 'RULE_INVALID')
      continue
    }
    const validation = await validateDestination('absolute', finalDest, req.destinationContext)
    if (!validation.ok) {
      skip(fileName, validation.code)
      continue
    }

    const destDir = validation.path
    if (!(await reader.exists(destDir))) {
      const root = path.parse(destDir).root
      if (!(await reader.exists(root))) {
        skip(fileName, 'DEST_UNAVAILABLE')
        continue
      }
    }

    // Cross-volume folder moves are not supported (would need a recursive copy).
    if (isDir && !sameVolume(full, finalDest)) {
      skip(fileName, 'CROSS_VOLUME')
      continue
    }

    const chosen = await planUniqueName(fileName, async (name) =>
      reader.exists(path.join(destDir, name))
    )

    const warnings: PlanWarning[] = []
    if (chosen.renamed) warnings.push('NAME_CONFLICT_WILL_RENAME')
    if (!isDir && finalDest && !sameVolume(full, finalDest)) warnings.push('CROSS_VOLUME')
    if (!(await reader.exists(destDir))) warnings.push('DEST_FOLDER_WILL_BE_CREATED')

    plan.items.push({
      itemId: randomUUID(),
      fileName,
      sourcePath: full,
      destPath: path.join(destDir, chosen.name),
      sizeBytes: stat.size,
      explanation,
      warnings,
    })
  }

  return plan
}