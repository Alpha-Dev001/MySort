/**
 * Rule recommendations.
 *
 * The behaviour under test is deliberately conservative: a pattern is only
 * offered once it has happened often enough, the fingerprint is stable so a
 * dismissed suggestion stays dismissed, and nothing about the detection
 * implies that a rule may be created without the user asking.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECOMMENDATION_THRESHOLD,
  describePattern,
  detectPatterns,
  fingerprintFor,
  suggestName,
  type MoveSample,
} from '../src/engine/recommendations'

function sample(over: Partial<MoveSample> = {}): MoveSample {
  return {
    fileName: 'invoice.pdf',
    extension: 'pdf',
    destination: 'Documents\\Invoices',
    finishedAt: '2026-01-01T00:00:00.000Z',
    initiatedBy: 'manual',
    ...over,
  }
}

describe('fingerprintFor', () => {
  it('is stable for the same extensions and destination', () => {
    expect(fingerprintFor(['pdf'], 'Invoices')).toBe(fingerprintFor(['pdf'], 'Invoices'))
  })

  it('does not depend on the order of the extensions', () => {
    expect(fingerprintFor(['pdf', 'docx'], 'Invoices')).toBe(
      fingerprintFor(['docx', 'pdf'], 'Invoices')
    )
  })

  it('changes when the destination changes', () => {
    expect(fingerprintFor(['pdf'], 'Invoices')).not.toBe(fingerprintFor(['pdf'], 'Archive'))
  })
})

describe('suggestName', () => {
  it('names a single-extension group after the type', () => {
    expect(suggestName(['pdf'], 'Documents\\Invoices')).toBe('PDF files')
  })

  it('names a multi-extension group after the folder', () => {
    expect(suggestName(['pdf', 'docx', 'txt', 'csv'], 'Documents\\Invoices')).toBe('Invoices files')
  })
})

describe('detectPatterns', () => {
  it('finds nothing below the threshold', () => {
    const patterns = detectPatterns([sample(), sample()], 3)
    expect(patterns).toHaveLength(0)
  })

  it('reports a pattern once it reaches the threshold', () => {
    const patterns = detectPatterns([sample(), sample(), sample()], 3)
    expect(patterns).toHaveLength(1)
    expect(patterns[0].extensions).toEqual(['pdf'])
    expect(patterns[0].destination).toBe('Documents\\Invoices')
    expect(patterns[0].occurrences).toBe(3)
    expect(patterns[0].manualOccurrences).toBe(3)
  })

  it('defaults to a threshold of three', () => {
    expect(DEFAULT_RECOMMENDATION_THRESHOLD).toBe(3)
    expect(detectPatterns([sample(), sample()])).toHaveLength(0)
    expect(detectPatterns([sample(), sample(), sample()])).toHaveLength(1)
  })

  it('keeps different destinations apart', () => {
    const patterns = detectPatterns(
      [
        sample({ destination: 'A' }),
        sample({ destination: 'A' }),
        sample({ destination: 'A' }),
        sample({ destination: 'B' }),
        sample({ destination: 'B' }),
        sample({ destination: 'B' }),
      ],
      3
    )
    expect(patterns).toHaveLength(2)
  })

  it('ignores files without an extension', () => {
    const patterns = detectPatterns(
      [sample({ extension: '', fileName: 'Makefile' }), sample({ extension: '' })],
      2
    )
    expect(patterns).toHaveLength(0)
  })

  it('orders the strongest pattern first', () => {
    const patterns = detectPatterns(
      [
        sample({ destination: 'Rare' }),
        sample({ destination: 'Rare' }),
        sample({ destination: 'Common' }),
        sample({ destination: 'Common' }),
        sample({ destination: 'Common' }),
        sample({ destination: 'Common' }),
      ],
      2
    )
    expect(patterns[0].destination).toBe('Common')
    expect(patterns[0].occurrences).toBe(4)
  })

  it('counts how many of the moves the user approved', () => {
    const patterns = detectPatterns(
      [
        sample({ initiatedBy: 'manual' }),
        sample({ initiatedBy: 'auto' }),
        sample({ initiatedBy: 'auto' }),
      ],
      3
    )
    expect(patterns[0].manualOccurrences).toBe(1)
  })
})

describe('describePattern', () => {
  it('states what was observed, not what will happen', () => {
    const pattern = detectPatterns([sample(), sample(), sample()], 3)[0]
    const text = describePattern(pattern)
    expect(text).toContain('3')
    expect(text).toContain('.pdf')
    expect(text).toContain('moves you approved')
  })

  it('says when MySort did the moving itself', () => {
    const pattern = detectPatterns(
      [sample({ initiatedBy: 'auto' }), sample({ initiatedBy: 'auto' }), sample({ initiatedBy: 'auto' })],
      3
    )[0]
    expect(describePattern(pattern)).toContain('on your behalf')
  })
})
