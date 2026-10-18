import React, { useLayoutEffect, useRef } from 'react'
import styles from './DataTable.module.css'

export interface Column<T> {
  key: string
  header: React.ReactNode
  /**
   * Relative width, e.g. `'2fr'`, `'120px'`, or `'auto'`.
   * `fr` values are normalised to percentages for the `<colgroup>`.
   */
  width?: string
  align?: 'start' | 'center' | 'end'
  /** Hides the header cell visually but keeps it for screen readers. */
  headerHidden?: boolean
  cell: (row: T) => React.ReactNode
  /** Applied to every <td> in the column, e.g. for truncation. */
  className?: string
}

export interface DataTableProps<T> {
  caption: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Extra class on a row, e.g. to tint failed rows. */
  rowClassName?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  empty?: React.ReactNode
  /**
   * Caps the table's height and scrolls it internally, e.g. `'min(58vh, 620px)'`.
   *
   * Two things this fixes. The header row can only stay pinned while something
   * above it scrolls — with an unbounded table the `<th>` stuck to a container
   * that never moved, so it scrolled away with the page and the table lost its
   * labels. And a capped box keeps a long list from turning the whole
   * window into one long scroll.
   */
  maxHeight?: string
  /**
   * Changing this value scrolls the table back to its first row.
   *
   * Replacing the rows of a capped scroller does not move it: it stays at
   * whatever row the reader had reached, which for paged data means each
   * "next page" opens somewhere in the middle. Paging screens pass the page
   * number here so the new page always starts where it says it does.
   */
  resetScrollKey?: string | number
}

/**
 * A real `<table>` with real `<th scope>` cells.
 *
 * The previous tables were div grids: they had no row/column semantics, so
 * assistive technology read them as one undifferentiated blob of text.
 *
 * Widths are emitted as a `<colgroup>`. `table-layout: fixed` ignores
 * `grid-template-columns`, so the sizing has to be declared on the columns
 * themselves or every column collapses to content width and the last one
 * clips its buttons.
 */
function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  onRowClick,
  empty,
  maxHeight,
  resetScrollKey,
}: DataTableProps<T>): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Read before the empty early-return below: React hooks must run in the same
  // order on every render, and `rows` can go 0 → n when a filter clears.
  useLayoutEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 })
  }, [resetScrollKey])

  if (rows.length === 0 && empty) {
    return <div className={styles.emptySlot}>{empty}</div>
  }

  const frTotal = columns.reduce((sum, c) => sum + (c.width?.endsWith('fr') ? Number.parseFloat(c.width) || 0 : 0), 0)
  const colWidth = (width?: string): string | undefined => {
    if (!width) return undefined
    if (width.endsWith('fr')) {
      const value = Number.parseFloat(width)
      if (!frTotal || !value) return undefined
      return `${(value / frTotal) * 100}%`
    }
    return width
  }

  return (
    <div
      ref={scrollerRef}
      className={styles.scroller}
      style={maxHeight ? ({ '--table-max-height': maxHeight } as React.CSSProperties) : undefined}
    >
      <table className={styles.table}>
        <caption className="srOnly">{caption}</caption>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: colWidth(c.width) }} />
          ))}
        </colgroup>
        <thead>
          <tr className={styles.head}>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={[
                  c.align === 'end' ? styles.alignEnd : c.align === 'center' ? styles.alignCenter : '',
                  c.headerHidden ? styles.headerHidden : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={[styles.row, rowClassName?.(row), onRowClick ? styles.clickable : ''].filter(Boolean).join(' ')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row)
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={[c.align === 'end' ? styles.alignEnd : c.align === 'center' ? styles.alignCenter : '', c.className]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default DataTable