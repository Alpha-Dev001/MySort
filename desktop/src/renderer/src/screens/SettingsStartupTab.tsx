import React from 'react'
import { Clock, Download, Monitor } from 'lucide-react'
import type { ApplicationSettings, SettingsPatch } from '../../../shared/types'
import { FieldRow } from '../components/Field'
import { Section } from '../components/Panel'
import Toggle from '../components/Toggle'

/** Tray behaviour, launch and resume — the Windows & startup tab. */
const StartupTab: React.FC<{
  settings: ApplicationSettings
  savingFor: (field: string) => React.ReactNode
  save: (patch: SettingsPatch, label: string) => void
}> = ({ settings, savingFor, save }) => {
  return (
    <Section title="Windows and startup">
      <FieldRow
        label={
          <>
            <Monitor size={14} aria-hidden="true" /> Keep running in the tray when I close the window
          </>
        }
        help="Closing the window hides it. Use the tray menu to quit completely."
        status={savingFor('closeButtonBehavior')}
      >
        <Toggle
          checked={settings.closeButtonBehavior === 'tray'}
          onChange={(next) => save({ closeButtonBehavior: next ? 'tray' : 'quit' }, 'Close button behaviour')}
          label="Keep running in the tray"
        />
      </FieldRow>
      <FieldRow
        label={
          <>
            <Download size={14} aria-hidden="true" /> Start MySort when I log in
          </>
        }
        status={savingFor('startWithWindows')}
      >
        <Toggle
          checked={settings.startWithWindows}
          onChange={(next) => save({ startWithWindows: next }, 'Start at login')}
          label="Start at login"
        />
      </FieldRow>
      <FieldRow
        label={
          <>
            <Clock size={14} aria-hidden="true" /> Resume monitoring on launch
          </>
        }
        help="MySort also checks for interrupted moves when it starts."
        status={savingFor('resumeMonitoringOnLaunch')}
      >
        <Toggle
          checked={settings.resumeMonitoringOnLaunch}
          onChange={(next) => save({ resumeMonitoringOnLaunch: next }, 'Resume on launch')}
          label="Resume monitoring on launch"
        />
      </FieldRow>
    </Section>
  )
}

export default StartupTab
