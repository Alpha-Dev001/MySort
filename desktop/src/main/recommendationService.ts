/**
 * Recommendation service: turns repeated, completed moves into suggestions.
 *
 * The rules it can break:
 *
 * - It never creates a rule on its own. `accept` is the only path to a rule,
 *   and it is always the user pressing the button.
 * - A dismissed recommendation keeps its fingerprint, so the same pattern is
 *   not offered again.
 * - The evidence line states what was observed, not what will happen.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { appError } from '../shared/errors'
import type { FileRule, RuleRecommendation, SearchResultPage } from '../shared/types'
import { OperationsRepo } from '../db/repositories/operationsRepo'
import { RecommendationsRepo } from '../db/repositories/recommendationsRepo'
import {
  DEFAULT_RECOMMENDATION_THRESHOLD,
  describePattern,
  detectPatterns,
  extensionOfSample,
  type MoveSample,
} from '../engine/recommendations'
import { isInside, normalizePath } from '../engine/pathSafety'
import { RulesService } from './rulesService'
import { SearchService } from './searchService'
import { SettingsService } from './settingsService'

export interface RecommendationServiceDeps {
  recommendationsRepo: RecommendationsRepo
  operationsRepo: OperationsRepo
  rulesService: RulesService
  searchService: SearchService
  settingsService: SettingsService
}

export class RecommendationService {
  constructor(private readonly deps: RecommendationServiceDeps) {}

  list(): RuleRecommendation[] {
    return this.deps.recommendationsRepo.list()
  }

  private threshold(): number {
    const configured = this.deps.settingsService.get().recommendationThreshold
    return Number.isFinite(configured) && configured >= 2
      ? Math.min(Math.floor(configured), 50)
      : DEFAULT_RECOMMENDATION_THRESHOLD
  }

  /**
   * Re-reads the move history and refreshes the pending suggestions.
   *
   * Accepted and dismissed recommendations are left exactly as they are.
   */
  detect(): RuleRecommendation[] {
    const moves = this.deps.operationsRepo.listCompletedMoves(2000)
    const destinationRoot = normalizePath(this.deps.settingsService.get().destinationRoot)

    const samples: MoveSample[] = []
    for (const move of moves) {
      const destDir = path.dirname(move.finalDestPath)
      // Only moves that landed inside the destination root can be expressed
      // as a relative rule.
      if (!isInside(destDir, destinationRoot)) continue
      const relative = destDir.slice(destinationRoot.length + 1)
      if (relative.length === 0) continue
      const extension = extensionOfSample(move.fileName)
      if (extension.length === 0) continue
      samples.push({
        fileName: move.fileName,
        extension,
        destination: relative,
        finishedAt: move.finishedAt,
        initiatedBy:
          move.initiatedBy === 'manual'
            ? 'manual'
            : move.initiatedBy === 'auto'
              ? 'auto'
              : 'other',
      })
    }

    const patterns = detectPatterns(samples, this.threshold())
    for (const pattern of patterns) {
      this.deps.recommendationsRepo.upsert({
        id: randomUUID(),
        fingerprint: pattern.fingerprint,
        payload: {
          name: pattern.name,
          extensions: pattern.extensions,
          namePattern: null,
          destination: pattern.destination,
        },
        evidence: {
          evidence: describePattern(pattern),
          occurrences: pattern.occurrences,
          firstSeenAt: pattern.firstSeenAt,
          lastSeenAt: pattern.lastSeenAt,
        },
      })
    }
    return this.list()
  }

  dismiss(id: string): RuleRecommendation[] {
    const recommendation = this.deps.recommendationsRepo.get(id)
    if (!recommendation) throw appError('NOT_FOUND', 'recommendation not found')
    this.deps.recommendationsRepo.setStatus(id, 'dismissed')
    return this.list()
  }

  /**
   * Creates the rule the user asked for and marks the suggestion accepted.
   *
   * The rule is created *enabled* only because the user asked for it here.
   */
  accept(id: string): FileRule {
    const recommendation = this.deps.recommendationsRepo.get(id)
    if (!recommendation) throw appError('NOT_FOUND', 'recommendation not found')
    if (recommendation.status === 'dismissed') {
      throw appError('CONFLICT', 'this suggestion was dismissed')
    }
    const row = this.deps.rulesService.create({
      name: recommendation.name,
      extensions: recommendation.extensions,
      namePattern: recommendation.namePattern,
      destination: { kind: 'relative', value: recommendation.destination },
      enabled: true,
    })
    this.deps.recommendationsRepo.setStatus(id, 'accepted')
    const rule = this.deps.rulesService.list().find((r) => r.id === row.id)
    if (!rule) throw appError('INTERNAL', 'the rule could not be read back')
    return rule
  }

  /**
   * Which files would the suggested rule match?
   *
   * The answer comes from the local index. When the index has not been built
   * the preview is empty and says so — it never guesses.
   */
  preview(id: string): SearchResultPage {
    const recommendation = this.deps.recommendationsRepo.get(id)
    if (!recommendation) throw appError('NOT_FOUND', 'recommendation not found')
    return this.deps.searchService.query({
      extensions: recommendation.extensions,
      limit: 50,
      sort: 'modified',
      order: 'desc',
    })
  }
}
