import React from 'react'
import { RotateCcw } from 'lucide-react'
import Button from '../components/Button'
import styles from './Settings.module.css'

/** The danger zone — the Reset tab. */
const ResetTab: React.FC<{ onReset: () => void }> = ({ onReset }) => {
  return (
    <section className={styles.dangerZone}>
      <div className={styles.dangerText}>
        <h2 className={styles.dangerTitle}>Reset MySort</h2>
        <p className={styles.dangerDescription}>
          Removes your rules, watched folders, settings and the whole move history. Files already moved are not
          put back — only the record of them is deleted.
        </p>
      </div>
      <Button variant="danger" onClick={onReset}>
        <RotateCcw size={14} /> Reset everything
      </Button>
    </section>
  )
}

export default ResetTab
