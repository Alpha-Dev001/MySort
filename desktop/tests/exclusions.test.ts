/**
 * Exclusions: what the index is never allowed to read.
 *
 * These rules are about metadata only. They must be exact — a path prefix
 * that is too broad would silently hide files, and one that is too narrow
 * would read something the user asked MySort to leave alone.
 */

import { describe, expect, it } from 'vitest'
import {
  isExcludedEntry,
  isExcludedExtension,
  isExcludedPath,
  normalizeExcludedExtensions,
  normalizeExcludedPaths,
} from '../src/engine/exclusions'

describe('normalizeExcludedPaths', () => {
  it('lowercases and de-duplicates', () => {
    expect(normalizeExcludedPaths(['C:\\Users\\Alex', 'c:\\users\\alex'])).toEqual(['c:\\users\\alex'])
  })

  it('drops empty entries', () => {
    expect(normalizeExcludedPaths(['', '  '])).toEqual([])
  })

  it('puts the longest path first so a nested folder is matched first', () => {
    const result = normalizeExcludedPaths(['C:\\a', 'C:\\a\\b'])
    expect(result[0]).toBe('c:\\a\\b')
  })
})

describe('normalizeExcludedExtensions', () => {
  it('strips dots and lowercases', () => {
    expect(normalizeExcludedExtensions(['.PDF', 'exe', ' EXE '])).toEqual(['exe', 'pdf'])
  })
})

describe('isExcludedPath', () => {
  it('matches the path itself', () => {
    expect(isExcludedPath('C:\\Private', ['C:\\Private'])).toBe(true)
  })

  it('matches everything below the path', () => {
    expect(isExcludedPath('C:\\Private\\notes.txt', ['C:\\Private'])).toBe(true)
  })

  it('does not match a sibling that merely shares a prefix', () => {
    expect(isExcludedPath('C:\\PrivateNotes\\a.txt', ['C:\\Private'])).toBe(false)
  })

  it('is case insensitive', () => {
    expect(isExcludedPath('c:\\private\\a.txt', ['C:\\Private'])).toBe(true)
  })
})

describe('isExcludedExtension', () => {
  it('matches case insensitively', () => {
    expect(isExcludedExtension('PDF', ['pdf'])).toBe(true)
  })

  it('does not match a different extension', () => {
    expect(isExcludedExtension('png', ['pdf'])).toBe(false)
  })

  it('never excludes a file without an extension', () => {
    expect(isExcludedExtension('', ['pdf'])).toBe(false)
  })
})

describe('isExcludedEntry', () => {
  it('skips dotfiles when hidden files are excluded', () => {
    expect(
      isExcludedEntry('.gitignore', 'C:\\a\\.gitignore', 'gitignore', {
        excludedPaths: [],
        excludedExtensions: [],
        excludeHidden: true,
      })
    ).toBe(true)
  })

  it('keeps dotfiles when hidden files are allowed', () => {
    expect(
      isExcludedEntry('.gitignore', 'C:\\a\\.gitignore', 'gitignore', {
        excludedPaths: [],
        excludedExtensions: [],
        excludeHidden: false,
      })
    ).toBe(false)
  })

  it('skips an excluded extension', () => {
    expect(
      isExcludedEntry('setup.exe', 'C:\\a\\setup.exe', 'exe', {
        excludedPaths: [],
        excludedExtensions: ['exe'],
        excludeHidden: false,
      })
    ).toBe(true)
  })

  it('skips an excluded folder', () => {
    expect(
      isExcludedEntry('secret.txt', 'C:\\Private\\secret.txt', 'txt', {
        excludedPaths: ['C:\\Private'],
        excludedExtensions: [],
        excludeHidden: false,
      })
    ).toBe(true)
  })

  it('keeps an ordinary file', () => {
    expect(
      isExcludedEntry('report.pdf', 'C:\\Docs\\report.pdf', 'pdf', {
        excludedPaths: ['C:\\Private'],
        excludedExtensions: ['exe'],
        excludeHidden: true,
      })
    ).toBe(false)
  })
})
