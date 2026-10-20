import React from 'react'
import logoUrl from '../../../../logo.svg'

export interface LogoProps {
  /** Rendered width and height in pixels. The mark is square. */
  size?: number
  /** Extra class name, for layout only. */
  className?: string
}

/**
 * The application logo: `logo.svg` from the project root, used exactly as it
 * is drawn.
 *
 * The file is the single source of truth for the mark. The app imports it
 * rather than redrawing it, so editing the SVG changes every place the logo
 * appears at once — there is no second copy to keep in sync.
 *
 * It is always decorative: the wordmark sits beside it, so it is hidden from
 * assistive technology and never announced on its own.
 */
const Logo: React.FC<LogoProps> = ({ size = 36, className }) => (
  <img
    className={className}
    src={logoUrl}
    alt=""
    aria-hidden="true"
    width={size}
    height={size}
    draggable={false}
  />
)

export default Logo
