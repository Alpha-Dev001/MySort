/**
 * Window creation with the hardened settings from the threat model:
 * context isolation, sandbox, no Node in the renderer, navigation guards,
 * permission denials, and a native-overlay title bar.
 */

import path from 'node:path'
import { BrowserWindow, nativeTheme, session, shell } from 'electron'
import { logger } from './logger'

const isDev = !((import.meta as ImportMeta & { env?: { PROD?: boolean } }).env?.PROD ?? false)
const APP_URL_HOST = 'localhost'

/** setTimeout as a promise, for the dev-server boot probe. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The frameless window uses a native overlay for minimise/maximise/close. That
 * overlay is painted by the OS, not by the renderer, so it cannot read the
 * renderer's CSS variables — it has to be told the theme explicitly or it sits
 * on the window as a black band in dark mode.
 *
 * These values mirror `--bg-app` in the renderer's styles.css.
 */
const CHROME = {
  light: { background: '#ffffff', symbol: '#3a3a44' },
  dark: { background: '#0c0c10', symbol: '#e6e6ee' },
} as const

/** Must match `--titlebar-h` in the renderer's styles.css. */
export const TITLEBAR_HEIGHT = 36

export function overlayFor(dark: boolean): { color: string; symbolColor: string; height: number } {
  const theme = dark ? CHROME.dark : CHROME.light
  return { color: theme.background, symbolColor: theme.symbol, height: TITLEBAR_HEIGHT }
}

/** Re-tints the overlay on every live window when the OS theme changes. */
export function watchWindowTheme(): void {
  const apply = (): void => {
    const overlay = overlayFor(nativeTheme.shouldUseDarkColors)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.setBackgroundColor(overlay.color)
        win.setTitleBarOverlay(overlay)
      } catch (e) {
        logger.warn(`could not retint window chrome: ${(e as Error).message}`)
      }
    }
  }
  nativeTheme.on('updated', apply)
}

export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (isDev && parsed.protocol === 'http:' && parsed.hostname === APP_URL_HOST) {
      return true
    }
    return parsed.protocol === 'file:'
  } catch {
    return false
  }
}

function openExternalIfAllowed(url: string): void {
  try {
    const parsed = new URL(url)
    const allowed = ['https://mysort.app', 'https://github.com']
    if (parsed.protocol === 'https:' && allowed.some((a) => parsed.href.startsWith(a))) {
      void shell.openExternal(parsed.href)
    } else {
      logger.warn(`blocked external open: ${parsed.protocol}//${parsed.host}`)
    }
  } catch {
    /* invalid url: ignore */
  }
}

export function createMainWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    // Matches --bg-app in the renderer; overridden if the OS theme changes.
    backgroundColor: overlayFor(dark).color,
    title: 'MySort',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor(dark),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, '../preload/index.js'),
      devTools: isDev,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      openExternalIfAllowed(url)
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`renderer gone: ${details.reason}`)
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) {
      win.webContents.reload()
    }
  })

  void loadRenderer(win)
  return win
}

export async function loadRenderer(win: BrowserWindow): Promise<void> {
  // electron-vite injects the renderer dev-server URL into process.env; it is
  // not part of import.meta.env, which Vite replaces with a static object.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  try {
    if (isDev && devUrl) {
      // The dev server can still be binding its port when the window boots
      // (first load failed with ERR_ABORTED in the field); probe with backoff
      // instead of leaving a dead window. Dev-only: production uses loadFile.
      for (let attempt = 1; attempt <= 10 && !win.isDestroyed(); attempt++) {
        try {
          await win.loadURL(devUrl)
          return
        } catch {
          await delay(250 * attempt)
        }
      }
      if (!win.isDestroyed()) logger.error(`failed to load renderer after retries: ${devUrl}`)
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
  } catch (e) {
    logger.error(`failed to load renderer: ${(e as Error).message}`)
  }
}

/** Deny every permission request (camera, mic, geolocation, notifications...). */
export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}
