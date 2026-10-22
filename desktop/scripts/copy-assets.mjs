/**
 * Copies the runtime assets the main process needs into the build output.
 *
 * The packaged application contains the `out` tree and nothing else, so a
 * tray icon living in `assets/` would never reach the installed program.
 * Copying it into `out/main/assets/` keeps the packaged app self-contained
 * and keeps the source tree free of build artefacts.
 *
 * Runs after `electron-vite build`.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Files the main process loads at runtime. */
const RUNTIME_ASSETS = ['icon.png', 'tray.png', 'tray@2x.png']

const SRC_DIR = path.join(ROOT, 'assets')
const DEST_DIR = path.join(ROOT, 'out', 'main', 'assets')

mkdirSync(DEST_DIR, { recursive: true })

let copied = 0
for (const name of RUNTIME_ASSETS) {
  const src = path.join(SRC_DIR, name)
  if (!existsSync(src)) {
    console.error(`missing runtime asset: assets/${name} (run: node scripts/generate-icons.mjs)`)
    process.exitCode = 1
    continue
  }
  copyFileSync(src, path.join(DEST_DIR, name))
  copied++
}

console.log(`copied ${copied} runtime asset(s) to out/main/assets`)
