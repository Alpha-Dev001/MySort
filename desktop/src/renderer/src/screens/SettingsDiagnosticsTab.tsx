import React from 'react'
import { FileDown, Info, ShieldCheck } from 'lucide-react'
import type { AppInfo, ApplicationSettings, LogLevel, SettingsPatch } from '../../../shared/types'
import Button from '../components/Button'
import { FieldRow, Select } from '../components/Field'
import { Section } from '../components/Panel'
import { Notice } from '../components/States'
import styles from './Settings.module.css'

/** Log level, version and the diagnostics export — the Diagnostics tab. */
const DiagnosticsTab: React.FC<{
  settings: ApplicationSettings
  info: AppInfo | null
  exporting: boolean
  savingFor: (field: string) => React.ReactNode
  save: (patch: SettingsPatch, label: string) => void
  onExport: () => void
}> = ({ settings, info, exporting, savingFor, save, onExport }) => {
  return (
    <>
      <Section
        title="Diagnostics"
        description="Everything here stays on this computer."
        actions={
          <Button variant="secondary" size="sm" onClick={onExport} loading={exporting}>
            <FileDown size={14} /> Export
          </Button>
        }
      >
        <FieldRow
          label="Log level"
          help="Debug records file names and is used for troubleshooting."
          status={savingFor('logLevel')}
        >
          <Select
            selectSize="sm"
            aria-label="Log level"
            value={settings.logLevel}
            onChange={(e) => save({ logLevel: e.target.value as LogLevel }, 'Log level')}
            options={[
              { value: 'error', label: 'Errors only' },
              { value: 'warn', label: 'Warnings' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Version">
          <span className={styles.version}>{info ? `${info.version} · ${info.platform}` : '—'}</span>
        </FieldRow>
        <Notice tone="info" icon={<Info size={15} />}>
          An exported diagnostics file contains your settings, folder counts and a tail of the log. Folder paths
          are redacted. It is never uploaded.
        </Notice>
      </Section>

      <p className={styles.footnote}>
        <ShieldCheck size={13} aria-hidden="true" />
        <span>
          MySort has no network access, no telemetry and no account. Everything it knows lives in{' '}
          {info && <code className={styles.dataPath}>{info.userDataPath}</code>}
        </span>
      </p>
    </>
  )
}

export default DiagnosticsTab
