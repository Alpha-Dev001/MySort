import { describe, expect, it } from 'vitest'
import { buildDefaultDenyPaths, isDeniedPath } from '../src/engine/pathSafety'

/**
 * Regression cover for the deny list.
 *
 * The deny list is prefix-matched by isDeniedPath, so an over-broad entry does
 * not fail loudly: it silently refuses every destination in the app. These tests
 * pin down both the entries that must be protected and the ones that must not
 * blanket-deny ordinary user locations.
 */

const INPUT = {
  windowsDir: 'C:\\Windows',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  userData: 'C:\\Users\\Alex\\AppData\\Roaming\\MySort',
  appData: 'C:\\Users\\Alex\\AppData\\Roaming',
  localAppData: 'C:\\Users\\Alex\\AppData\\Local',
  startupDirs: [
    'C:\\Users\\Alex\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
  ],
}

const deny = buildDefaultDenyPaths(INPUT)

describe('buildDefaultDenyPaths', () => {
  it('protects system and app-data locations', () => {
    for (const denied of [
      'C:\\Windows\\System32',
      'C:\\Program Files\\App',
      'C:\\Program Files (x86)\\App',
      'C:\\Users\\Alex\\AppData\\Roaming\\MySort',
      'C:\\Users\\Alex\\AppData\\Local\\Temp',
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.exe',
    ]) {
      expect(isDeniedPath(denied, deny), denied).toBe(true)
    }
  })

  it('does not deny ordinary user folders', () => {
    // MySort's own default destination root, and typical user locations.
    for (const allowed of [
      'C:\\Users\\Alex\\Documents\\MySort',
      'C:\\Users\\Alex\\Documents\\MySort\\Images',
      'C:\\Users\\Alex\\Downloads',
      'C:\\Users\\Alex\\Desktop',
      'D:\\Sorted\\Images',
    ]) {
      expect(isDeniedPath(allowed, deny), allowed).toBe(false)
    }
  })

  it('contains no drive-root entries', () => {
    // A drive root plus isInside's prefix match would deny the whole drive.
    const driveRoots = deny.filter((d) => /^[a-z]:\\?$/.test(d))
    expect(driveRoots).toEqual([])
  })

  it('lowercases and de-duplicates entries', () => {
    const dupes = buildDefaultDenyPaths({
      windowsDir: 'C:\\Windows',
      appData: 'C:\\Users\\Alex\\AppData\\Roaming',
      localAppData: 'C:\\Users\\Alex\\AppData\\Roaming',
    })
    expect(dupes).toEqual([...new Set(dupes)])
    expect(dupes.every((d) => d === d.toLowerCase())).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isDeniedPath('c:\\windows\\system32', deny)).toBe(true)
    expect(isDeniedPath('C:\\USERS\\ALEX\\DOCUMENTS\\MYSORT', deny)).toBe(false)
  })
})