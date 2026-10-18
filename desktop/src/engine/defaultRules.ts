/**
 * Built-in default classification table, versioned with the app (never migrated
 * through the database). Custom rules from the database always win over this.
 */

import type { Category } from '../shared/types'

export const CATEGORY_LABELS: Record<Category, string> = {
  images: 'Images',
  videos: 'Videos',
  documents: 'Documents',
  audio: 'Audio',
  archives: 'Archives',
  other: 'Other',
}

const TABLE: Record<string, Category> = {
  // images
  png: 'images', jpg: 'images', jpeg: 'images', gif: 'images', bmp: 'images', webp: 'images',
  heic: 'images', heif: 'images', tif: 'images', tiff: 'images', ico: 'images', svg: 'images',
  raw: 'images', cr2: 'images', nef: 'images', arw: 'images', dng: 'images', avif: 'images',
  // videos
  mp4: 'videos', mkv: 'videos', avi: 'videos', mov: 'videos', wmv: 'videos', flv: 'videos',
  webm: 'videos', m4v: 'videos', mpg: 'videos', mpeg: 'videos', ts: 'videos', mts: 'videos',
  // documents
  pdf: 'documents', doc: 'documents', docx: 'documents', xls: 'documents', xlsx: 'documents',
  ppt: 'documents', pptx: 'documents', txt: 'documents', rtf: 'documents', csv: 'documents',
  odt: 'documents', ods: 'documents', odp: 'documents', md: 'documents', epub: 'documents',
  pages: 'documents', numbers: 'documents', key: 'documents', xmind: 'documents',
  // audio
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  wma: 'audio', opus: 'audio', aiff: 'audio', alac: 'audio',
  // archives
  zip: 'archives', rar: 'archives', '7z': 'archives', tar: 'archives', gz: 'archives',
  bz2: 'archives', xz: 'archives', zst: 'archives', iso: 'archives', cab: 'archives',
  'tar.gz': 'archives', 'tar.bz2': 'archives', 'tar.xz': 'archives',
  // installers / executables fall through to other (custom rules may claim them)
  exe: 'other', msi: 'other', msix: 'other', bat: 'other', cmd: 'other', ps1: 'other',
  apk: 'other', deb: 'other', rpm: 'other', dmg: 'other', pkg: 'other',
}

export const DEFAULT_EXTENSION_CATEGORY: Readonly<Record<string, Category>> = TABLE

/**
 * Seed rules created once on first run (stored in the database, fully editable).
 * If the user deletes them, the built-in table above still classifies files.
 */
export interface SeedRule {
  name: string
  extensions: string[]
  namePattern: string | null
  /** Relative to the destination root. */
  destination: string
}

export const SEED_RULES: readonly SeedRule[] = [
  { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'csv'], namePattern: null, destination: 'Documents' },
  { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'], namePattern: null, destination: 'Pictures' },
  { name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'], namePattern: null, destination: 'Videos' },
  { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a'], namePattern: null, destination: 'Music' },
  { name: 'Archives', extensions: ['zip', 'rar', '7z', 'tar', 'gz'], namePattern: null, destination: 'Archives' },
  { name: 'Installers', extensions: ['exe', 'msi', 'msix'], namePattern: null, destination: 'Apps' },
]

/** Key used to ensure the seed runs exactly once per profile. */
export const SETTINGS_KEY_RULES_SEEDED = 'rulesSeeded'
