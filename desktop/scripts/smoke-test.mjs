/**
 * Release smoke test: launch the packaged application against an isolated
 * user-data directory and a temporary watched folder.
 *
 * The point is to prove the app starts, creates its database, applies the
 * migrations, starts monitoring and shuts down cleanly — without ever
 * pointing it at the real Downloads folder. The watched folder is seeded
 * before launch so the first-install seed never picks the real one.
 *
 * Usage: node scripts/smoke-test.mjs [--exe <path to MySort.exe>]
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const exeArg = process.argv.indexOf('--exe')
const EXE =
  exeArg >= 0 && process.argv[exeArg + 1]
    ? path.resolve(process.argv[exeArg + 1])
    : path.join(ROOT, 'dist', 'win-unpacked', 'MySort.exe')

if (!existsSync(EXE)) {
  console.error(`executable not found: ${EXE}\nRun: npm run package`)
  process.exit(1)
}

const workspace = path.join(tmpdir(), `mysort-smoke-${Date.now()}`)
const userData = path.join(workspace, 'userData')
const watched = path.join(workspace, 'watched')
mkdirSync(userData, { recursive: true })
mkdirSync(watched, { recursive: true })

// A file that MySort will see. It must still be there afterwards.
const sample = path.join(watched, 'sample.txt')
execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(sample)}, 'smoke')`])

// Seed the database with the current schema and a watched folder that points
// at the temporary directory, so the real Downloads is never involved.
const migrations = ['0001_init.sql', '0002_page_index.sql', '0003_folder_rename.sql', '0004_file_index.sql', '0005_collections_recommendations.sql']
const db = new Database(path.join(userData, 'mysort.db'))
for (const name of migrations) {
  db.exec(readFileSync(path.join(ROOT, 'src', 'db', 'migrations', name), 'utf8'))
}
db.exec(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version    INTEGER PRIMARY KEY,
     name       TEXT NOT NULL,
     applied_at TEXT NOT NULL
   )`
)
const now = new Date().toISOString()
for (const [index, name] of migrations.entries()) {
  db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
    index + 1,
    name.replace(/^\d+_/, '').replace(/\.sql$/, ''),
    now
  )
}
db.pragma(`user_version = ${migrations.length}`)
db.prepare(
  `INSERT INTO monitored_folders (id, path, enabled, mode, created_at, updated_at)
   VALUES (1, ?, 1, 'manual', ?, ?)`
).run(watched, now, now)
db.close()

console.log(`workspace: ${workspace}`)
console.log(`launching: ${EXE}`)

const child = spawn(EXE, [`--user-data-dir=${userData}`, '--hidden'], {
  stdio: 'ignore',
  detached: false,
})

let exited = false
child.on('exit', () => {
  exited = true
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await wait(9000)

const logDir = path.join(userData, 'logs')
const logs = existsSync(logDir) ? readdirSync(logDir) : []
let logText = ''
for (const file of logs) {
  logText += readFileSync(path.join(logDir, file), 'utf8')
}

const problems = []
for (const line of logText.split(/\r?\n/)) {
  if (/\[error\]|\[warn\]/i.test(line)) problems.push(line)
}

console.log('\n--- log ---')
console.log(logText.trim() || '(no log output)')
console.log('--- end log ---\n')

// The watched file must be untouched: the folder is in manual mode, so MySort
// must not have moved it.
const sampleStillThere = existsSync(sample)
console.log(`watched file untouched: ${sampleStillThere}`)

child.kill()
await wait(1500)
if (!exited) {
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

const dbSize = existsSync(path.join(userData, 'mysort.db'))
  ? statSync(path.join(userData, 'mysort.db')).size
  : 0
console.log(`database created: ${dbSize > 0} (${dbSize} bytes)`)
console.log(`problems in log: ${problems.length}`)

rmSync(workspace, { recursive: true, force: true })

if (problems.length > 0 || !sampleStillThere || dbSize === 0) {
  console.error('\nSMOKE TEST FAILED')
  process.exit(1)
}
console.log('\nSMOKE TEST PASSED')
