/**
 * Route model and hash synchronisation.
 *
 * The app previously kept the current screen in a single `useState` with no URL
 * behind it, so a reload always dropped the user back to the first screen and
 * Back/Forward did nothing. This keeps the same tiny model and adds a hash
 * mapping, which gives deep links and history behaviour without pulling in a
 * router dependency.
 *
 * Locations are `#/<route>` plus, where a route has a nested address, a
 * tail: `#/rules/<ruleId>` for a rule's detail page and `#/settings/<tab>`
 * for the open settings tab. Nested pages are real addresses — they can be
 * linked, refreshed and restored by Back/Forward.
 */

export type Route =
  | 'onboarding'
  | 'overview'
  | 'inbox'
  | 'rules'
  | 'suggestions'
  | 'history'
  | 'search'
  | 'duplicates'
  | 'collections'
  | 'settings'

export const ROUTES: readonly Route[] = [
  'onboarding',
  'overview',
  'inbox',
  'rules',
  'suggestions',
  'history',
  'search',
  'duplicates',
  'collections',
  'settings',
] as const

export const ROUTE_TITLES: Record<Route, string> = {
  onboarding: 'Set up MySort',
  overview: 'Overview',
  inbox: 'Inbox',
  rules: 'Rules',
  suggestions: 'Suggestions',
  history: 'History',
  search: 'Search',
  duplicates: 'Duplicates',
  collections: 'Collections',
  settings: 'Settings',
}

export const DEFAULT_ROUTE: Route = 'overview'

/** Tabs on the Settings screen, one short page each instead of one long scroll. */
export type SettingsTab = 'folders' | 'behaviour' | 'notifications' | 'startup' | 'diagnostics' | 'reset'

export const SETTINGS_TABS: readonly SettingsTab[] = [
  'folders',
  'behaviour',
  'notifications',
  'startup',
  'diagnostics',
  'reset',
] as const

/** Guards an opaque hash tail to a real tab so deep links can't invent one. */
export function readSettingsTab(raw: string | null): SettingsTab | null {
  return (SETTINGS_TABS as readonly string[]).includes(raw ?? '') ? (raw as SettingsTab) : null
}

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'folders'

export interface Location {
  route: Route
  /** Rule id when the hash points at `#/rules/<id>`; otherwise null. */
  ruleId: string | null
  /** Open tab when the hash points at `#/settings/<tab>`; otherwise null. */
  settingsTab: SettingsTab | null
}

function fromHash(): Location | null {
  const raw = window.location.hash.replace(/^#\//, '')
  const [head, ...rest] = raw.split('/')
  if (!(ROUTES as readonly string[]).includes(head)) return null
  const route = head as Route
  // 'rules' and 'settings' nest; ids are opaque so they are round-tripped
  // verbatim, tabs are guarded to the known set.
  const tail = rest.join('/')
  const ruleId = route === 'rules' && tail.length > 0 ? decodeURIComponent(tail) : null
  const settingsTab = route === 'settings' ? readSettingsTab(tail.length > 0 ? tail : null) : null
  return { route, ruleId, settingsTab }
}

export function readLocation(): Location | null {
  return fromHash()
}

export function writeLocation(location: Location): void {
  let next = `#/${location.route}`
  if (location.ruleId) next = `#/rules/${encodeURIComponent(location.ruleId)}`
  else if (location.settingsTab) next = `#/settings/${location.settingsTab}`
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

