import React from 'react'
import type { ApplicationSettings, SettingsPatch } from '../../../shared/types'
import { FieldRow, Select } from '../components/Field'
import { Section } from '../components/Panel'
import Toggle from '../components/Toggle'

/** How much MySort does on its own — the Behaviour tab. */
const BehaviourTab: React.FC<{
  settings: ApplicationSettings
  savingFor: (field: string) => React.ReactNode
  save: (patch: SettingsPatch, label: string) => void
}> = ({ settings, savingFor, save }) => {
  return (
    <Section title="Behaviour" description="How much MySort does on its own.">
      <FieldRow
        label="Sort folders too"
        help="Off by default. When on, top-level folders in a watched folder are moved into a 'Folders' bucket inside the destination folder. Only turn this on if you want whole folders moved."
        status={savingFor('sortFolders')}
      >
        <Toggle
          checked={settings.sortFolders}
          onChange={(next) => save({ sortFolders: next }, 'Sort folders')}
          label="Sort folders too"
        />
      </FieldRow>
      <FieldRow
        label="Review before moving"
        help="Off by default: finished downloads are organised without waiting for your approval. Turn it on to have MySort wait for you in the Inbox."
        status={savingFor('previewBeforeAuto')}
      >
        <Toggle
          checked={settings.previewBeforeAuto}
          onChange={(next) => save({ previewBeforeAuto: next }, 'Review setting')}
          label="Review before moving"
        />
      </FieldRow>
      <FieldRow
        label="Keep history for"
        help="Older activity is deleted when this window passes."
        status={savingFor('historyRetentionDays')}
      >
        <Select
          selectSize="sm"
          aria-label="Keep history for"
          value={settings.historyRetentionDays}
          onChange={(e) => save({ historyRetentionDays: Number(e.target.value) }, 'History retention')}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: '365', label: '1 year' },
          ]}
        />
      </FieldRow>
      <FieldRow
        label="Undo window"
        help="How long a completed move can be reversed."
        status={savingFor('undoWindowDays')}
      >
        <Select
          selectSize="sm"
          aria-label="Undo window"
          value={settings.undoWindowDays}
          onChange={(e) => save({ undoWindowDays: Number(e.target.value) }, 'Undo window')}
          options={[
            { value: '1', label: '1 day' },
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </FieldRow>
    </Section>
  )
}

export default BehaviourTab
