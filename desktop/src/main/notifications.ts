/** Native toast notifications; never required for correctness. */

import { Notification } from 'electron'
import { logger } from './logger'

export function notifyUser(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) {
      logger.info(`notification (unsupported): ${title} — ${body}`)
      return
    }
    const n = new Notification({ title, body, silent: true })
    n.on('click', () => {})
    n.show()
  } catch (e) {
    logger.warn(`notification failed: ${(e as Error).message}`)
  }
}
