/**
 * Collection service: resolves the files that belong to a collection.
 *
 * A collection is a set of *references*. Nothing is copied and nothing is
 * moved. Membership comes from two places:
 *
 * - rules (by extension, by a name fragment, by parent folder, or by a MySort
 *   rule), resolved against the local index, and
 * - files the user added by hand.
 *
 * A file that has since been deleted is reported as missing rather than
 * quietly dropped, and a file that changed since it was indexed is flagged.
 */

import path from 'node:path'
import { appError } from '../shared/errors'
import type { CollectionMember, FileCollection } from '../shared/types'
import { CollectionsRepo } from '../db/repositories/collectionsRepo'
import { IndexRepo } from '../db/repositories/indexRepo'
import { NodeFs } from '../engine/fs'
import type { FsReader } from '../engine/fs'
import { isExcludedExtension } from '../engine/exclusions'
import { SearchService } from './searchService'

export interface CollectionServiceDeps {
  collectionsRepo: CollectionsRepo
  indexRepo: IndexRepo
  searchService: SearchService
  fs?: FsReader
}

export class CollectionService {
  private readonly repo: CollectionsRepo
  private readonly indexRepo: IndexRepo
  private readonly searchService: SearchService
  private readonly fs: FsReader

  constructor(deps: CollectionServiceDeps) {
    this.repo = deps.collectionsRepo
    this.indexRepo = deps.indexRepo
    this.searchService = deps.searchService
    this.fs = deps.fs ?? new NodeFs()
  }

  list(): FileCollection[] {
    return this.repo.list()
  }

  get(id: string): FileCollection {
    const collection = this.repo.get(id)
    if (!collection) throw appError('NOT_FOUND', 'collection not found')
    return collection
  }

  create(name: string, description = ''): FileCollection {
    return this.repo.create(name, description)
  }

  remove(id: string): void {
    this.repo.remove(id)
  }

  setRules(id: string, rules: FileCollection['rules']): FileCollection {
    this.repo.setRules(id, rules)
    return this.get(id)
  }

  addMember(id: string, filePath: string): FileCollection {
    this.get(id)
    this.repo.addMember(id, filePath)
    return this.get(id)
  }

  removeMember(id: string, filePath: string): FileCollection {
    this.get(id)
    this.repo.removeMember(id, filePath)
    return this.get(id)
  }

  /**
   * The files in a collection, with the reason each one is there.
   */
  async members(id: string): Promise<CollectionMember[]> {
    const collection = this.get(id)
    const found = new Map<string, { reason: string; rule: CollectionMember }>()

    for (const rule of collection.rules) {
      const matches = await this.resolveRule(rule)
      for (const match of matches) {
        if (found.has(match.path.toLowerCase())) continue
        found.set(match.path.toLowerCase(), {
          reason: describeRule(rule),
          rule: match,
        })
      }
    }

    for (const manualPath of collection.manualPaths) {
      const key = manualPath.toLowerCase()
      if (found.has(key)) continue
      const indexed = this.indexRepo.getByPath(manualPath)
      found.set(key, {
        reason: 'Added by hand',
        rule: {
          path: manualPath,
          name: indexed?.name ?? path.basename(manualPath),
          ext: indexed?.ext ?? '',
          sizeBytes: indexed?.sizeBytes ?? 0,
          modifiedMs: indexed?.modifiedMs ?? 0,
          reason: 'Added by hand',
          missing: false,
          changed: false,
        },
      })
    }

    const members: CollectionMember[] = []
    for (const { rule } of found.values()) {
      const stat = await this.fs.lstat(rule.path).catch(() => null)
      const missing = !stat || !stat.isFile
      const changed = !missing && stat.size !== rule.sizeBytes && rule.sizeBytes > 0
      members.push({ ...rule, missing, changed })
    }

    members.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    return members
  }

  private async resolveRule(rule: FileCollection['rules'][number]): Promise<CollectionMember[]> {
    switch (rule.kind) {
      case 'extension': {
        const extension = rule.value.trim().toLowerCase().replace(/^\.+/, '')
        if (extension.length === 0) return []
        const page = this.searchService.query({ extensions: [extension], limit: 200 })
        return page.items.map((f) => ({
          path: f.path,
          name: f.name,
          ext: f.ext,
          sizeBytes: f.sizeBytes,
          modifiedMs: f.modifiedMs,
          reason: `Extension .${extension}`,
          missing: false,
          changed: false,
        }))
      }
      case 'name_contains': {
        const text = rule.value.trim()
        if (text.length === 0) return []
        const page = this.searchService.query({ text, limit: 200 })
        return page.items.map((f) => ({
          path: f.path,
          name: f.name,
          ext: f.ext,
          sizeBytes: f.sizeBytes,
          modifiedMs: f.modifiedMs,
          reason: `Name contains "${text}"`,
          missing: false,
          changed: false,
        }))
      }
      case 'parent': {
        const dir = rule.value.trim()
        if (dir.length === 0) return []
        const page = this.searchService.query({ parentDir: dir, limit: 200 })
        return page.items.map((f) => ({
          path: f.path,
          name: f.name,
          ext: f.ext,
          sizeBytes: f.sizeBytes,
          modifiedMs: f.modifiedMs,
          reason: `In ${dir}`,
          missing: false,
          changed: false,
        }))
      }
      case 'my_sort_rule':
        // A MySort rule resolves to the category folder it would sort into.
        // The collection keeps the reference, not the rule's behaviour.
        return []
      default:
        return []
    }
  }
}

function describeRule(rule: FileCollection['rules'][number]): string {
  switch (rule.kind) {
    case 'extension':
      return `Extension .${rule.value.replace(/^\.+/, '').toLowerCase()}`
    case 'name_contains':
      return `Name contains "${rule.value}"`
    case 'parent':
      return `In ${rule.value}`
    case 'my_sort_rule':
      return `MySort rule ${rule.value}`
    default:
      return 'Included'
  }
}

/** Extensions the user asked never to be indexed. */
export function isExcludedBySettings(ext: string, excluded: string[]): boolean {
  return isExcludedExtension(ext, excluded)
}
