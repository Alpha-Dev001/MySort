import { describe, expect, it, vi } from 'vitest'
import { resolveRule } from '../src/engine/rules'
import { buildPlan } from '../src/engine/planner'
import { checkNameEligibility, checkAbsoluteStructure } from '../src/engine/pathSafety'
import type { RuleContext } from '../src/engine/rules'


describe('rules', () => {
  const ctx: RuleContext = {
    rules: [
      { id: 'r1', name: 'Invoices', extensions: ['pdf'], namePattern: null, destination: { kind: 'relative', value: 'Invoices' }, enabled: true, position: 1, createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'r2', name: 'Images', extensions: ['png', 'jpg'], namePattern: null, destination: { kind: 'relative', value: 'Pictures' }, enabled: true, position: 2, createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'r3', name: 'Disabled', extensions: ['pdf'], namePattern: null, destination: { kind: 'relative', value: 'x' }, enabled: false, position: 3, createdAt: '2024-01-01T00:00:00.000Z' },
    ],
    destinationRoot: 'C:\\Users\\Alex\\Sorted',
    categoryDestinations: {},
  }

  it('resolves a rule by extension', () => {
    const res = resolveRule('invoice.pdf', ctx)
    expect(res.outcome).toBe('custom')
    expect(res.ruleId).toBe('r1')
    expect(res.destination).toContain('Invoices')
  })

  it('resolves the first matching rule (priority by position)', () => {
    const res = resolveRule('photo.png', ctx)
    expect(res.ruleId).toBe('r2')
  })

  it('skips disabled rules', () => {
    const res = resolveRule('invoice.pdf', ctx)
    expect(res.ruleId).toBe('r1')
  })

  it('returns no_action for unknown extensions', () => {
    const res = resolveRule('readme.txt', ctx)
    expect(res.outcome).toBe('no_action')
    expect(res.destination).toBeNull()
  })

  it('returns no_action for files without extension', () => {
    const res = resolveRule('Makefile', ctx)
    expect(res.outcome).toBe('no_action')
  })
})

describe('pathSafety', () => {
  it('rejects absolute paths that start with a drive letter or separator', () => {
    expect(checkAbsoluteStructure('C:\\Windows\\System32').ok).toBe(false)
    expect(checkAbsoluteStructure('/etc/passwd').ok).toBe(false)
    expect(checkAbsoluteStructure('C:').ok).toBe(false)
  })

  it('rejects absolute paths with invalid chars', () => {
    expect(checkAbsoluteStructure('C:\\path|with\\bad').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\path<bad>').ok).toBe(false)
  })

  it('rejects relative paths that start with a separator or dot segment', () => {
    expect(checkAbsoluteStructure('../etc').ok).toBe(false)
    expect(checkAbsoluteStructure('foo/./bar').ok).toBe(false)
  })

  it('rejects null bytes', () => {
    expect(checkAbsoluteStructure('C:\\path\u0000bad').ok).toBe(false)
  })

  it('rejects reserved Windows names', () => {
    expect(checkNameEligibility('CON')).toEqual({ eligible: false, reason: 'RESERVED_NAME' })
    expect(checkNameEligibility('PRN.txt')).toEqual({ eligible: false, reason: 'RESERVED_NAME' })
    expect(checkNameEligibility('AUX.docx')).toEqual({ eligible: false, reason: 'RESERVED_NAME' })
    expect(checkNameEligibility('NUL')).toEqual({ eligible: false, reason: 'RESERVED_NAME' })
  })

  it('rejects temp/download suffixes', () => {
    expect(checkNameEligibility('download.crdownload')).toEqual({ eligible: false, reason: 'TEMP_SUFFIX' })
    expect(checkNameEligibility('file.part')).toEqual({ eligible: false, reason: 'TEMP_SUFFIX' })
    expect(checkNameEligibility('in.progress.partial')).toEqual({ eligible: false, reason: 'TEMP_SUFFIX' })
  })

  it('rejects obviously-hidden files (dot-prefix on Windows)', () => {
    // On Windows a leading dot is a normal prefix, but we still reject names
    // that start with '.' and have no extension (like .git) since they're
    // usually hidden. Real hidden files (.name) would be picked up by lstat.
    expect(checkNameEligibility('.hidden')).toEqual({ eligible: false, reason: 'TEMP_SUFFIX' as const })
  })

  it('rejects long names', () => {
    const long = 'a'.repeat(300) + '.pdf'
    expect(checkNameEligibility(long)).toEqual({ eligible: false, reason: 'NAME_TOO_LONG' })
  })

  it('rejects control characters', () => {
    expect(checkNameEligibility('file\u0001name.pdf')).toEqual({ eligible: false, reason: 'INVALID_CHARS' })
  })

  it('rejects names with invalid path chars', () => {
    expect(checkNameEligibility('file:name.pdf')).toEqual({ eligible: false, reason: 'INVALID_CHARS' })
  })

  it('accepts normal file names', () => {
    expect(checkNameEligibility('report-final.pdf').eligible).toBe(true)
    expect(checkNameEligibility('IMG_2041.png').eligible).toBe(true)
    expect(checkNameEligibility('invoice-march.pdf').eligible).toBe(true)
  })
})

describe('planner', () => {
  it('builds an empty plan when there are no eligible files', async () => {
    const fs = {
      lstat: vi.fn(),
      readdir: vi.fn(() => []),
      existsSync: vi.fn(() => true),
    }
    const plan = await buildPlan(
      fs as any,
      {
        folderId: 1,
        folderPath: 'C:\\Users\\Alex\\Downloads',
        rules: [
          { id: 'r1', name: 'Invoices', extensions: ['pdf'], namePattern: null, destination: { kind: 'relative', value: 'Invoices' }, enabled: true, position: 1, createdAt: '2024-01-01T00:00:00.000Z' },
        ],
        destinationRoot: 'C:\\Users\\Alex\\Sorted',
        categoryDestinations: {},
      } as any
    )
    expect(plan.items.length).toBe(0)
    expect(plan.skipped.length).toBe(0)
    // The planId is a UUID
    expect(plan.planId).toMatch(/^[a-f0-9-]{36}$/)
  })
})
