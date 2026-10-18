/**
 * System tray: a small menu that mirrors the window controls. The close button
 * hides to tray by default (settings.closeButtonBehavior), so the tray is the
 * always-available way back in.
 */

import { Menu, Tray, app, nativeImage } from 'electron'
import type { MonitoringStatus } from '../shared/types'
import { logger } from './logger'

export interface TrayCallbacks {
  openWindow(): void
  toggleMonitoring(): void
  organizeNow(): void
  openSettings(): void
  quit(): void
}

export class TrayController {
  private tray: Tray | null = null
  private status: MonitoringStatus | null = null

  constructor(private readonly callbacks: TrayCallbacks) {}

  create(): void {
    if (this.tray) return
    try {
      this.tray = new Tray(nativeImage.createEmpty())
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
