import React from 'react'
import type { ApplicationSettings, NotificationPreference, SettingsPatch } from '../../../shared/types'
import { FieldRow, Segmented } from '../components/Field'
import { Section } from '../components/Panel'

/** Which interruptions MySort is allowed to make — the Notifications tab. */
const NotificationsTab: React.FC<{
  settings: ApplicationSettings
  savingFor: (field: string) => React.ReactNode
  save: (patch: SettingsPatch, label: string) => void
}> = ({ settings, savingFor, save }) => {
  return (
    <Section title="Notifications" description="When MySort is allowed to interrupt you.">
      <FieldRow label="Notify me about" status={savingFor('notifications')}>
        <Segmented
          ariaLabel="Notification preference"
          value={settings.notifications}
          onChange={(next: NotificationPreference) => save({ notifications: next }, 'Notification preference')}
          options={[
            { value: 'failures' as const, label: 'Failures only' },
            { value: 'summaries' as const, label: 'Summaries' },
            { value: 'none' as const, label: 'Nothing' },
          ]}
        />
      </FieldRow>
    </Section>
  )
}

export default NotificationsTab
