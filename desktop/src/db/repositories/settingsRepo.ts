/** Settings storage: one row per key, JSON-encoded value. */

import type Database from 'better-sqlite3'

interface SettingRow {
  value_json: string
}

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  get<T>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value_json FROM settings WHERE setting_key = ?`)
      .get(key) as SettingRow | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return null
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), new Date().toISOString())
  }

  getBool(key: string, fallback: boolean): boolean {
    const v = this.get<boolean>(key)
    return typeof v === 'boolean' ? v : fallback
  }

  getNumber(key: string, fallback: number): number {
    const v = this.get<number>(key)
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }

  getString(key: string, fallback: string): string {
    const v = this.get<string>(key)
    return typeof v === 'string' && v.length > 0 ? v : fallback
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE setting_key = ?`).run(key)
  }

  deleteAll(): void {
    this.db.prepare(`DELETE FROM settings`).run()
  }
}
