import React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Select } from './Field'
import { formatCount, pluralize } from '../lib/format'
import styles from './Pagination.module.css'

export interface PaginationProps {
  /** 1-based. The renderer owns page state; this component never stores it. */
  page: number
  /** Rows per page. */
  pageSize: number
  /** Size of the whole result set, not just this page. */
  total: number
  /** Rows actually rendered on this page — the last page is usually short. */
  itemCount: number
  /** Noun for the summary line and the screen-reader announcement. */
  unit?: string
  /** Omit to hide the page-size control. */
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: readonly number[]
  onPageChange: (page: number) => void
  /** Greys the controls out without hiding them, e.g. mid-request. */
  busy?: boolean
}

/**
 * Numbered page controls for a bounded table.
 *
 * Deliberately not an infinite scroller. This app is a table of moves you come
 * back to and scan, not a feed you fall through: a fixed page size keeps the
 * page a known length, keeps the footer reachable without scrolling past
 * hundreds of rows to find it, and makes "where am I" answerable at a glance.
 *
 * Every control is a real button with a real label, so the bar is usable from
 * the keyboard and readable by a screen reader without extra wiring.
 */
const Pagination: React.FC<PaginationProps> = ({
  page,
  pageSize,
  total,
  itemCount,
  unit = 'rows',
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  onPageChange,
  busy = false,
}) => {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  // Counted from the rows actually on this page rather than from `total`, so a
  // short final page reports its real end instead of an implied one.
  const last = itemCount === 0 ? 0 : first + itemCount - 1
  const canPrev = page > 1 && !busy
  const canNext = page < pageCount && !busy

  // Arrow keys page from anywhere inside the bar — the controls are the
  // obvious thing to reach for, so the obvious shortcut should work.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.target instanceof HTMLSelectElement) return
    if (e.key === 'ArrowLeft' && canPrev) {
      e.preventDefault()
      onPageChange(page - 1)
    } else if (e.key === 'ArrowRight' && canNext) {
      e.preventDefault()
      onPageChange(page + 1)
    } else if (e.key === 'Home' && canPrev) {
      e.preventDefault()
      onPageChange(1)
    } else if (e.key === 'End' && canNext) {
      e.preventDefault()
      onPageChange(pageCount)
    }
  }

  return (
    <nav className={styles.bar} aria-label="Pagination" onKeyDown={onKeyDown}>
      <p className={styles.summary}>
        {total === 0 ? (
          `No ${unit}`
        ) : (
          <>
            Showing <strong>{formatCount(first)}</strong>–<strong>{formatCount(last)}</strong> of{' '}
            <strong>{formatCount(total)}</strong> {pluralize(total, unit)}
          </>
        )}
      </p>

      <div className={styles.controls}>
        {onPageSizeChange && (
          <label className={styles.size}>
            <span className={styles.sizeLabel}>Per page</span>
            <Select
              selectSize="sm"
              value={pageSize}
              disabled={busy}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
              aria-label="Rows per page"
            />
          </label>
        )}

        <div className={styles.pages}>
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={!canPrev}
            aria-label="Previous page"
          >
            <ChevronLeft size={15} />
          </button>

          {pageWindow(page, pageCount).map((entry, i) =>
            entry === null ? (
              <span key={`gap-${i}`} className={styles.gap} aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                className={[styles.page, entry === page ? styles.pageCurrent : ''].filter(Boolean).join(' ')}
                onClick={() => onPageChange(entry)}
                disabled={busy}
                aria-current={entry === page ? 'page' : undefined}
                aria-label={`Page ${entry}`}
              >
                {formatCount(entry)}
              </button>
            ),
          )}

          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={!canNext}
            aria-label="Next page"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {/* Announced only when it changes, so paging is audible but not spammy. */}
      <p className="srOnly" role="status">
        {total === 0
          ? `No ${unit}`
          : `Page ${formatCount(page)} of ${formatCount(pageCount)}, showing ${formatCount(
              first,
            )} to ${formatCount(last)} of ${formatCount(total)} ${unit}`}
      </p>
    </nav>
  )
}

/**
 * Page numbers to render, with `null` marking an elision.
 *
 * Always shows the first and last page plus a window around the current one, so
 * the control has a stable width — the bar must not resize as you page through.
 */
export function pageWindow(page: number, pageCount: number, radius = 1): (number | null)[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)

  const pages = new Set<number>([1, pageCount])
  for (let p = page - radius; p <= page + radius; p++) {
    if (p >= 1 && p <= pageCount) pages.add(p)
  }

  const sorted = [...pages].sort((a, b) => a - b)
  const out: (number | null)[] = []
  let previous = 0
  for (const p of sorted) {
    if (previous && p - previous > 1) out.push(null)
    out.push(p)
    previous = p
  }
  return out
}

export default Pagination
