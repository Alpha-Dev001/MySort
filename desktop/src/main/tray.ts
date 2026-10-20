/**
 * System tray: a small menu that mirrors the window controls. The close button
 * hides to tray by default (settings.closeButtonBehavior), so the tray is the
 * always-available way back in.
 */

import { Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { MonitoringStatus } from '../shared/types'
import { logger } from './logger'

export interface TrayCallbacks {
  openWindow(): void
  toggleMonitoring(): void
  organizeNow(): void
  openSettings(): void
  quit(): void
}

/**
 * The tray icon ships as a real file in `out/main/assets/` (copied from
 * `assets/` by scripts/copy-assets.mjs), not as an empty image.
 *
 * The 32px file is preferred on Windows: the shell draws the tray icon at
 * 16px, and downscaling a 32px source keeps the mark legible where a
 * hand-rasterised 16px icon does not.
 */
function trayIcon(): Electron.NativeImage {
  const candidates = [
    path.join(__dirname, 'assets', 'tray@2x.png'),
    path.join(__dirname, 'assets', 'tray.png'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  logger.warn('tray icon asset not found; falling back to an empty image')
  return nativeImage.createEmpty()
}

export class TrayController {
  private tray: Tray | null = null
  private status: MonitoringStatus | null = null

  constructor(private readonly callbacks: TrayCallbacks) {}

  create(): void {
    if (this.tray) return
    try {
      this.tray = new Tray(trayIcon())
      this.tray.setToolTip('MySort')
      this.updateMenu()
      this.tray.on('double-click', () => this.callbacks.openWindow())
    } catch (e) {
      logger.warn(`tray unavailable: ${(e as Error).message}`)
      this.tray = null
    }
  }

  setStatus(status: MonitoringStatus): void {
    this.status = status
    this.updateMenu()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private updateMenu(): void {
    if (!this.tray) return
    const active = this.status?.state === 'running'
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'Open MySort', click: () => this.callbacks.openWindow() },
      { type: 'separator' },
      {
        label: active ? 'Monitoring active' : `Monitoring ${this.status?.state ?? 'stopped'}`,
        enabled: false,
      },
      {
        label: active ? 'Pause monitoring' : 'Resume monitoring',
        click: () => this.callbacks.toggleMonitoring(),
      },
      { label: 'Organize now (preview)', click: () => this.callbacks.organizeNow() },
      { type: 'separator' },
      { label: 'Settings', click: () => this.callbacks.openSettings() },
      { label: `Quit ${app.getName()}`, click: () => this.callbacks.quit() },
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }
}
