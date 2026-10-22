import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const boundaryMessage = (what) =>
  `${what} must not be imported here; this layer stays pure and testable.`

/** Engine may not depend on Electron, React, the database, or the logger. */
const engineRestricted = {
  paths: [
    { name: 'electron', message: boundaryMessage('Electron') },
    { name: 'react', message: boundaryMessage('React') },
    { name: 'react-dom', message: boundaryMessage('React') },
    { name: 'lucide-react', message: boundaryMessage('React components') },
    { name: 'better-sqlite3', message: boundaryMessage('The database driver') },
    { name: 'electron-log', message: boundaryMessage('electron-log') },
  ],
  patterns: [
    { group: ['../db/*', '../db/**', '../*/db/*'], message: boundaryMessage('The db layer') },
    { group: ['../main/*', '../main/**', '../preload/*'], message: boundaryMessage('Electron main code') },
  ],
}

/** Renderer never touches Node, Electron internals, or the file system. */
const rendererRestricted = {
  paths: [
    { name: 'electron', message: boundaryMessage('Electron') },
    { name: 'better-sqlite3', message: boundaryMessage('The database driver') },
    { name: 'chokidar', message: boundaryMessage('The file watcher') },
    { name: 'electron-log', message: boundaryMessage('electron-log') },
  ],
  patterns: [
    { group: ['node:*'], message: boundaryMessage('Node built-ins') },
    { group: ['../engine/*', '../engine/**'], message: boundaryMessage('The engine') },
    { group: ['../db/*', '../db/**'], message: boundaryMessage('The db layer') },
    { group: ['../main/*', '../main/**'], message: boundaryMessage('The main process') },
  ],
}

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', engineRestricted] },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: { 'no-restricted-imports': ['error', rendererRestricted] },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', '*.config.mts', 'scripts/**/*.mjs', 'scripts/**/*.cjs'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  }
)
