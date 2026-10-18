import { describe, expect, it, vi } from 'vitest'
import { resolveRule } from '../src/engine/rules'
import { buildPlan } from '../src/engine/planner'
import {
  checkNameEligibility,
  checkAbsoluteStructure,
  checkRelativeStructure,
  sanitizeDestName,
} from '../src/engine/pathSafety'
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

  it('falls back to the built-in default for a known extension no rule claims', () => {
    // .txt is in the built-in table, so it resolves to a category destination
    // rather than being left alone. Only genuinely unknown types are no_action.
    const res = resolveRule('readme.txt', ctx)
    expect(res.outcome).toBe('default')
    expect(res.ruleKind).toBe('default')
    expect(res.destination).toContain('Documents')
  })

  it('returns no_action for unknown extensions', () => {
    const res = resolveRule('readme.xyzzy', ctx)
    expect(res.outcome).toBe('default')
    expect(res.category).toBe('other')
    expect(res.destination).toContain('Other')
  })

  it('returns no_action for files without extension', () => {
    const res = resolveRule('Makefile', ctx)
    expect(res.outcome).toBe('no_action')
    expect(res.destination).toBeNull()
  })
})

describe('checkAbsoluteStructure', () => {
  // Structure only. Whether a given location may be *used* is a policy
  // question answered later by validateDestination (deny list, monitored
  // folders); these tests must not conflate the two.

  it('accepts a well-formed absolute path', () => {
    expect(checkAbsoluteStructure('C:\\Users\\Alex\\Sorted').ok).toBe(true)
    expect(checkAbsoluteStructure('D:\\Photos\\2026').ok).toBe(true)
  })

  it('accepts structurally valid but policy-protected locations', () => {
    // C:\\Windows is a legal path. It is refused because it is deny-listed,
    // not because it is malformed — path-safety.test.ts covers that.
    expect(checkAbsoluteStructure('C:\\Windows\\System32').ok).toBe(true)
  })

  it('rejects drive-relative and rooted-but-not-absolute forms', () => {
    expect(checkAbsoluteStructure('C:').ok).toBe(false)
    expect(checkAbsoluteStructure('../etc').ok).toBe(false)
    expect(checkAbsoluteStructure('foo/./bar').ok).toBe(false)
  })

  it('rejects invalid path characters', () => {
    expect(checkAbsoluteStructure('C:\\path|with\\bad').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\path<bad>').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\path"bad"').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\path?bad').ok).toBe(false)
  })

  it('rejects null bytes and control characters', () => {
    expect(checkAbsoluteStructure('C:\\path\u0000bad').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\path\u0001bad').ok).toBe(false)
  })

  it('rejects reserved Windows device names', () => {
    expect(checkAbsoluteStructure('C:\\CON').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\folder\\NUL\\x').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\COM1\\x').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\LPT1\\x').ok).toBe(false)
    // A reserved stem is still reserved once an extension is present.
    expect(checkAbsoluteStructure('C:\\folder\\CON.txt').ok).toBe(false)
  })

  it('rejects network and device paths', () => {
    expect(checkAbsoluteStructure('\\\\server\\share\\file').ok).toBe(false)
    expect(checkAbsoluteStructure('\\\\.\\C:\\x').ok).toBe(false)
    expect(checkAbsoluteStructure('\\\\?\\C:\\x').ok).toBe(false)
  })

  it('rejects alternate data streams', () => {
    expect(checkAbsoluteStructure('C:\\file.txt:stream').ok).toBe(false)
  })

  it('rejects segments ending in a dot or space', () => {
    expect(checkAbsoluteStructure('C:\\folder.\\x').ok).toBe(false)
    expect(checkAbsoluteStructure('C:\\folder \\x').ok).toBe(false)
  })

  it('rejects paths beyond the length limit', () => {
    expect(checkAbsoluteStructure('C:\\' + 'a'.repeat(33_000)).ok).toBe(false)
  })
})

describe('checkRelativeStructure', () => {
  it('accepts ordinary relative destinations', () => {
    expect(checkRelativeStructure('Documents').ok).toBe(true)
    expect(checkRelativeStructure('Documents/Invoices').ok).toBe(true)
  })

  it('rejects separators, drive letters and traversal', () => {
    expect(checkRelativeStructure('/etc').ok).toBe(false)
    expect(checkRelativeStructure('\\etc').ok).toBe(false)
    expect(checkRelativeStructure('C:/Windows').ok).toBe(false)
    expect(checkRelativeStructure('../secrets').ok).toBe(false)
    expect(checkRelativeStructure('docs/../secrets').ok).toBe(false)
  })

  it('rejects null bytes and invalid characters', () => {
    expect(checkRelativeStructure('doc\u0000s').ok).toBe(false)
    expect(checkRelativeStructure('docs|invoices').ok).toBe(false)
  })

  it('rejects empty and over-long destinations', () => {
    expect(checkRelativeStructure('').ok).toBe(false)
    expect(checkRelativeStructure('a'.repeat(201)).ok).toBe(false)
  })
})

describe('checkNameEligibility', () => {
  // Deliberately name-only and cheap: this runs on every watcher event, so it
  // must not touch the disk. Type-level checks live in checkStatEligibility
  // and structural ones in checkAbsoluteStructure.

  it('rejects temp/download suffixes', () => {
    expect(checkNameEligibility('download.crdownload')).toEqual({ eligible: false, reason: 'TEMP_FILE' })
    expect(checkNameEligibility('file.part')).toEqual({ eligible: false, reason: 'TEMP_FILE' })
    expect(checkNameEligibility('in.progress.partial')).toEqual({ eligible: false, reason: 'TEMP_FILE' })
    expect(checkNameEligibility('movie.mp4.tmp')).toEqual({ eligible: false, reason: 'TEMP_FILE' })
  })

  it('rejects dotfiles and OS/Office lock files', () => {
    expect(checkNameEligibility('.hidden')).toEqual({ eligible: false, reason: 'EXCLUDED' })
    expect(checkNameEligibility('.gitignore')).toEqual({ eligible: false, reason: 'EXCLUDED' })
    expect(checkNameEligibility('~$report.docx')).toEqual({ eligible: false, reason: 'EXCLUDED' })
    expect(checkNameEligibility('desktop.ini')).toEqual({ eligible: false, reason: 'EXCLUDED' })
    expect(checkNameEligibility('Thumbs.db')).toEqual({ eligible: false, reason: 'EXCLUDED' })
  })

  it('accepts normal file names', () => {
    expect(checkNameEligibility('report-final.pdf').eligible).toBe(true)
    expect(checkNameEligibility('IMG_2041.png').eligible).toBe(true)
    expect(checkNameEligibility('invoice-march.pdf').eligible).toBe(true)
    expect(checkNameEligibility('a.b.c.tar.gz').eligible).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(checkNameEligibility('DOWNLOAD.CRDOWNLOAD')).toEqual({ eligible: false, reason: 'TEMP_FILE' })
    expect(checkNameEligibility('DESKTOP.INI')).toEqual({ eligible: false, reason: 'EXCLUDED' })
  })
})

describe('sanitizeDestName', () => {
  // The last line of defence for the destination file name. Names that the
  // gate above lets through are still made safe here before being written.

  it('rescues reserved device names', () => {
    expect(sanitizeDestName('CON')).toBe('_CON')
    expect(sanitizeDestName('nul.txt')).toBe('_nul.txt')
  })

  it('strips control characters', () => {
    expect(sanitizeDestName('file\u0001name.pdf')).toBe('filename.pdf')
  })

  it('strips bidi overrides used to disguise extensions', () => {
    expect(sanitizeDestName('invoice\u202Egpj.exe')).toBe('invoicegpj.exe')
  })

  it('never returns an empty name', () => {
    expect(sanitizeDestName('')).toBe('file')
    expect(sanitizeDestName('\u0000')).toBe('file')
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
