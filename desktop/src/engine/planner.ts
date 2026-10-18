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
import { resolveRule, type RuleContext } from './rules'
import {
  checkNameEligibility,
  checkStatEligibility,
  isInside,
  pathsEqual,
  sameVolume,
  validateDestination,
  type DestinationContext,
} from './pathSafety'
import { planUniqueName } from './uniqueName'
import type { FsReader } from './fs'
import type { OrganizationPlan, PlanWarning } from '../shared/types'

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

    // A file already sitting under the destination root has nothing to do.
    if (
      isInside(full, req.destinationContext.destinationRoot) ||
      pathsEqual(full, req.destinationContext.destinationRoot)
    ) {
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

    // Nothing to classify without an extension; the file stays where it is.
    if (candidateSuffixes(fileName).length === 0) {
      skip(fileName, 'NO_EXTENSION')
      continue
    }

    const resolution = resolveRule(fileName, req.rules)
    if (resolution.outcome === 'no_action') {
      skip(fileName, 'NO_EXTENSION')
      continue
    }
    if (resolution.outcome === 'error' || !resolution.destination) {
      skip(fileName, resolution.error?.code ?? 'RULE_INVALID')
      continue
    }

    const validation = await validateDestination('absolute', resolution.destination, req.destinationContext)
    if (!validation.ok) {
      skip(fileName, validation.code)
      continue
    }

    const destDir = validation.path
    if (!(await reader.exists(destDir))) {
      // The folder will be created by the executor, but only if the volume is
      // actually there; otherwise there is nowhere to put the file.
      const root = path.parse(destDir).root
      if (!(await reader.exists(root))) {
        skip(fileName, 'DEST_UNAVAILABLE')
        continue
      }
    }

    const chosen = await planUniqueName(fileName, async (name) =>
      reader.exists(path.join(destDir, name))
    )

    const warnings: PlanWarning[] = []
    if (chosen.renamed) warnings.push('NAME_CONFLICT_WILL_RENAME')
    if (!sameVolume(full, resolution.destination)) warnings.push('CROSS_VOLUME')
    if (!(await reader.exists(destDir))) warnings.push('DEST_FOLDER_WILL_BE_CREATED')

    plan.items.push({
      itemId: randomUUID(),
      fileName,
      sourcePath: full,
      destPath: path.join(destDir, chosen.name),
      sizeBytes: stat.size,
      explanation: resolution.explanation,
      warnings,
    })
  }

  return plan
}