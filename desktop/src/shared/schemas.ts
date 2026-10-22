/**
 * Runtime validation for every IPC payload. Main re-runs these as the real check;
 * the renderer uses the same schemas for instant form feedback.
 *
 * All request objects are strict: unknown keys are rejected.
 */

import { z } from 'zod'

export const themePreferenceSchema = z.enum(['light', 'dark', 'system'])

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque id')

/** Raw extension entry; normalization (lowercase, strip dots) happens in the rules service. */
export const extensionItemSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_+.-]+$/, 'letters, digits, _ + - and internal dots only')

/** Wildcard filename pattern: '*' and '?' only. No path separators. */
export const namePatternSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => !/[/\\:"<>|]/.test(s), 'must not contain path separators or : " < > |')
  // Control characters are exactly what this guard exists to reject, so the
  // no-control-regex rule does not apply here.
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f]/.test(s), 'must not contain control characters')

/** Destination relative to the destination root. */
export const relativeDestinationSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes('\u0000'), 'must not contain null bytes')
  .refine((s) => !/^[\\/]/.test(s), 'must not start with a path separator')
  .refine((s) => !/^[A-Za-z]:/.test(s), 'must not contain a drive letter')
  .refine(
    (s) => !s.split(/[\\/]/).some((seg) => seg === '..' || seg === '.'),
    'must not contain "." or ".." segments'
  )
  .refine((s) => !/[<>:"|?*]/.test(s), 'contains characters that are not allowed in paths')

export const ruleDestinationInputSchema = z.union([
  z.strictObject({ kind: z.literal('relative'), value: relativeDestinationSchema }),
  z.strictObject({ kind: z.literal('absolute'), grantId: idSchema }),
])

/**
 * Updates may also say "keep": without it, changing anything else about a rule
 * whose destination is an absolute folder would force a pointless re-pick of
 * that folder through a fresh grant. Creators always state a destination, so
 * only the update schema accepts this variant.
 */
const ruleUpdateDestinationSchema = z.union([
  ruleDestinationInputSchema.options[0],
  ruleDestinationInputSchema.options[1],
  z.strictObject({ kind: z.literal('keep') }),
])

const ruleFields = {
  name: z.string().trim().min(1).max(80),
  extensions: z.array(extensionItemSchema).max(50),
  namePattern: z.string().max(120).nullable(),
  destination: ruleDestinationInputSchema,
  enabled: z.boolean(),
}

const hasCriterion = <T extends { extensions: string[]; namePattern: string | null }>(r: T): boolean =>
  r.extensions.length > 0 || (r.namePattern !== null && r.namePattern.length > 0)

const ruleMessage = {
  message: 'a rule needs at least one extension or a filename pattern',
  path: ['extensions'],
}

export const ruleInputSchema = z.strictObject(ruleFields).refine(hasCriterion, ruleMessage)

export const ruleUpdateSchema = z
  .strictObject({ ruleId: idSchema, ...ruleFields, destination: ruleUpdateDestinationSchema })
  .refine(hasCriterion, ruleMessage)

export const ruleIdSchema = z.strictObject({ ruleId: idSchema })
export const ruleSetEnabledSchema = z.strictObject({ ruleId: idSchema, enabled: z.boolean() })
export const ruleReorderSchema = z.strictObject({
  orderedIds: z.array(idSchema).min(1).max(200),
})
export const ruleTestSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
})

// ---------------------------------------------------------------------------
// Settings / folders / monitoring
// ---------------------------------------------------------------------------

export const settingsPatchSchema = z.strictObject({
  startWithWindows: z.boolean().optional(),
  closeButtonBehavior: z.enum(['tray', 'quit']).optional(),
  resumeMonitoringOnLaunch: z.boolean().optional(),
  notifications: z.enum(['failures', 'summaries', 'none']).optional(),
  previewBeforeAuto: z.boolean().optional(),
  sortFolders: z.boolean().optional(),
  historyRetentionDays: z.number().int().min(30).max(3650).optional(),
  undoWindowDays: z.number().int().min(1).max(365).optional(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  onboardingCompleted: z.boolean().optional(),
  recommendationThreshold: z.number().int().min(2).max(50).optional(),
  destinationRootGrantId: idSchema.optional(),
})

/** Literal confirmation for destructive reset; handler checks the exact value. */
export const settingsResetSchema = z.strictObject({ confirm: z.string().min(1).max(32) })

export const folderPickSchema = z.strictObject({
  purpose: z.enum(['monitor', 'destination', 'index']),
})
export const folderAddSchema = z.strictObject({ grantId: idSchema, mode: z.enum(['manual', 'auto']) })
export const folderIdSchema = z.strictObject({ folderId: z.number().int().min(1) })
export const folderSetModeSchema = z.strictObject({
  folderId: z.number().int().min(1),
  mode: z.enum(['manual', 'auto']),
})

// ---------------------------------------------------------------------------
// History / diagnostics
// ---------------------------------------------------------------------------

export const historyListSchema = z.strictObject({
  query: z.string().max(200).optional(),
  status: z
    .enum(['all', 'planned', 'in_progress', 'completed', 'failed', 'skipped', 'needs_review'])
    .optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
})

export const operationIdSchema = z.strictObject({ operationId: idSchema })
export const showInFolderSchema = z.strictObject({
  operationId: idSchema,
  which: z.enum(['source', 'destination']),
})

export const rendererErrorSchema = z.strictObject({
  message: z.string().min(1).max(2000),
  stack: z.string().max(4000).optional(),
})

/** Payload schema for channels that take no input. */
export const emptySchema = z.null()

// ---------------------------------------------------------------------------
// Local search / metadata index
// ---------------------------------------------------------------------------

const epochMs = z.number().int().min(0).max(4_102_444_800_000)

export const searchQuerySchema = z.strictObject({
  text: z.string().max(200).optional(),
  fuzzy: z.boolean().optional(),
  extensions: z.array(z.string().max(40)).max(50).optional(),
  parentDir: z.string().max(4096).optional(),
  sizeMin: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  sizeMax: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  modifiedAfter: epochMs.nullable().optional(),
  modifiedBefore: epochMs.nullable().optional(),
  createdAfter: epochMs.nullable().optional(),
  createdBefore: epochMs.nullable().optional(),
  sort: z.enum(['name', 'modified', 'size', 'relevance']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
})

export const searchRecentSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
})

export const indexScopeSchema = z.strictObject({
  scope: z.strictObject({
    roots: z.array(z.string().min(1).max(4096)).max(20),
    maxDepth: z.number().int().min(0).max(16),
    excludedPaths: z.array(z.string().max(4096)).max(50),
    excludedExtensions: z.array(z.string().max(40)).max(200),
    excludeHidden: z.boolean(),
  }),
})

export const searchStartSchema = z.strictObject({
  rebuild: z.boolean().optional(),
})

export const pathPayloadSchema = z.strictObject({
  path: z.string().min(1).max(4096),
})

export const duplicatesScanSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
})

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export const recommendationIdSchema = z.strictObject({ id: idSchema })

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const collectionRuleSchema = z.strictObject({
  kind: z.enum(['extension', 'name_contains', 'parent', 'my_sort_rule']),
  value: z.string().min(1).max(4096),
})

export const collectionCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400).optional(),
})

export const collectionIdSchema = z.strictObject({ id: idSchema })

export const collectionSetRulesSchema = z.strictObject({
  id: idSchema,
  rules: z.array(collectionRuleSchema).max(50),
})

export const collectionMemberSchema = z.strictObject({
  id: idSchema,
  path: z.string().min(1).max(4096),
})

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const inboxPlanSchema = z.strictObject({
  folderId: z.number().int().min(1),
})

export const inboxApplySchema = z.strictObject({
  planId: idSchema,
  itemIds: z.array(idSchema).max(500),
})

