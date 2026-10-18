import React from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import type { ApplicationSettings, MonitoredFolder } from '../../../shared/types'
import Button from '../components/Button'
import { FieldRow, Segmented } from '../components/Field'
import { Section } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { EmptyState, Notice } from '../components/States'
import { folderStateLabel, folderStateTone, formatDate, shortenPath } from '../lib/format'
import styles from './Settings.module.css'

/** Watched folders and the destination root — the Folders tab. */
const FoldersTab: React.FC<{
  settings: ApplicationSettings
  folders: MonitoredFolder[]
  onAddFolder: () => void
  onRemoveFolder: (folder: MonitoredFolder) => void
  onSetFolderMode: (folder: MonitoredFolder, mode: 'manual' | 'auto') => void
  onPickDestinationRoot: () => void
}> = ({
  settings,
  folders,
  onAddFolder,
  onRemoveFolder,
  onSetFolderMode,
  onPickDestinationRoot,
}) => {
  return (
    <>
      <Section
        title="Watched folders"
        description="MySort only looks at loose files directly inside these folders."
        actions={
          <Button variant="secondary" size="sm" onClick={onAddFolder}>
            <Plus size={14} /> Add folder
          </Button>
        }
      >
        {folders.length === 0 ? (
          <EmptyState
            compact
            icon={<FolderOpen size={17} />}
            title="No folders are being watched"
            description="Add a folder and MySort will start sorting finished downloads from it."
            action={
              <Button variant="primary" size="sm" onClick={onAddFolder}>
                <FolderOpen size={14} /> Choose a folder
              </Button>
            }
          />
        ) : (
          <ul className={styles.folderList}>
            {folders.map((folder) => (
              <li key={folder.id} className={styles.folderRow}>
                <span className={styles.folderIcon} aria-hidden="true">
                  <FolderOpen size={16} />
                </span>
                <div className={styles.folderText}>
                  <span className={styles.folderPath} title={folder.path}>
                    {shortenPath(folder.path, 60)}
                  </span>
                  <span className={styles.folderMeta}>
                    Added {formatDate(folder.createdAt)}
                    {folder.pendingCandidates > 0 && ` · ${folder.pendingCandidates} waiting`}
                  </span>
                </div>
                <StatusPill tone={folderStateTone(folder.state)} size="sm">
                  {folderStateLabel(folder.state)}
                </StatusPill>
                <Segmented
                  ariaLabel={`Mode for ${folder.path}`}
                  value={folder.mode}
                  onChange={(mode) => onSetFolderMode(folder, mode)}
                  options={[
                    { value: 'auto' as const, label: 'Auto' },
                    { value: 'manual' as const, label: 'Manual' },
                  ]}
                />
                <Button
                  variant="quiet"
                  size="sm"
                  iconOnly
                  onClick={() => onRemoveFolder(folder)}
                  aria-label={`Stop watching ${folder.path}`}
                  title="Stop watching"
                >
                  <X size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <FieldRow label="Destination root" help="Every rule destination is resolved inside this folder.">
          <code className={styles.pathValue} title={settings.destinationRoot}>
            {shortenPath(settings.destinationRoot, 34)}
          </code>
          <Button variant="secondary" onClick={onPickDestinationRoot}>
            Change
          </Button>
        </FieldRow>
      </Section>

      <Notice tone="info" icon={<FolderOpen size={15} />}>
        MySort only looks at loose files directly inside a watched folder — never inside subfolders, and never at
        files that are still being written.
      </Notice>
    </>
  )
}

export default FoldersTab
