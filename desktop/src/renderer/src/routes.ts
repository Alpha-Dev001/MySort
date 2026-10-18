/**
 * Route model and hash synchronisation.
 *
 * The app previously kept the current screen in a single `useState` with no URL
 * behind it, so a reload always dropped the user back to the first screen and
 * Back/Forward did nothing. This keeps the same tiny model and adds a hash
 * mapping, which gives deep links and history behaviour without pulling in a
 * router dependency.
 *
 * Locations are `#/<route>` or, for the one nested page, `#/rules/<ruleId>` —
 * a rule's detail page is a real address, so it can be linked, refreshed and
 * backed out of.
 */

export type Route = 'onboarding' | 'overview' | 'rules' | 'history' | 'settings'

export const ROUTES: readonly Route[] = [
  'onboarding',
  'overview',
  'rules',
  'history',
  'settings',
] as const

export const ROUTE_TITLES: Record<Route, string> = {
  onboarding: 'Set up MySort',
  overview: 'Overview',
  rules: 'Rules',
  history: 'History',
  settings: 'Settings',
}

export const DEFAULT_ROUTE: Route = 'overview'

export interface Location {
  route: Route
  /** Rule id when the hash points at `#/rules/<id>`; otherwise null. */
  ruleId: string | null
}

function fromHash(): Location | null {
  const raw = window.location.hash.replace(/^#\//, '')
  const [head, ...rest] = raw.split('/')
  if (!(ROUTES as readonly string[]).includes(head)) return null
  const route = head as Route
  // Only 'rules' nests; ids are opaque so they are round-tripped verbatim.
  const tail = rest.join('/')
  const ruleId = route === 'rules' && tail.length > 0 ? decodeURIComponent(tail) : null
  return { route, ruleId }
}

export function readLocation(): Location | null {
  return fromHash()
}

export function writeLocation(location: Location): void {
  const next = location.ruleId ? `#/rules/${encodeURIComponent(location.ruleId)}` : `#/${location.route}`
  if (window.location.hash !== next) {
    // replaceState keeps the initial paint from pushing a history entry that
    // Back would immediately undo.
    window.history.replaceState(null, '', next)
  }
}

/** Subscribes to hash changes. Returns an unsubscribe for effect cleanup. */
export function onHashChange(handler: (location: Location | null) => void): () => void {
  const listener = (): void => handler(fromHash())
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}
