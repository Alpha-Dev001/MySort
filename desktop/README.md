# MySort

Every file. In its place. MySort watches a folder, waits until a download has
really finished, and sorts files into a destination folder according to rules
you control — and it can now help you find what you already have.

Everything stays on this computer. There is no account, no telemetry and no
network access of any kind.

## What it does

### Organizing

- **Monitors** your chosen folder for finished downloads (skips in-progress
  files, hidden files, and folders).
- **Classifies** files by extension into categories (Images, Videos, Documents,
  Audio, Archives, other).
- **Orders rules** by position; the first matching enabled rule wins.
- **Previews** every planned move on the **Inbox** screen so you can review
  before anything happens.
- **Applies** approved moves with an intent log and a stable-fingerprint gate
  (stable stats, 800 ms apart) before touching a file.
- **Recovers** interrupted moves on next startup (checked via
  `OperationsRepo.findUnfinished`).
- **Undoes** completed moves within the undo window (configurable, default 30
  days), with auto-rename when the original name is taken.
- **Follows renamed folders**, so renaming your watched folder does not lose
  it.

### Discovering

- **Search** — find files by name, type, size, folder or date, using a local
  metadata index. Fuzzy name matching is available.
- **Duplicates** — find files whose *contents* are byte-for-byte identical.
  Size is only a candidate filter; a duplicate is confirmed by a SHA-256
  content hash.
- **Collections** — named sets of files that stay exactly where they are.
  A collection holds references, never copies.
- **Suggestions** — rules MySort noticed in the moves you have already made.
  A suggestion is never activated on its own.

## Defaults, stated plainly

These are the settings the app starts with. Every one of them can be changed
in Settings.

| Setting | Default | What it means |
| --- | --- | --- |
| `sortFolders` | **off** | Top-level folders in a watched folder are *not* moved. Turning it on moves them into a `Folders` bucket inside the destination. |
| `previewBeforeAuto` | **off** | In auto mode, finished downloads are organised without waiting for you. Turn it on to hold them in the Inbox for review. |
| `resumeMonitoringOnLaunch` | on | MySort starts watching again when it launches. |
| `startWithWindows` | on | The login item is registered. |
| `closeButtonBehavior` | `tray` | Closing the window hides it; the tray menu quits it. |
| `notifications` | `failures` | Only failures interrupt you. |
| `historyRetentionDays` | 90 | Finished history older than this is deleted. |
| `undoWindowDays` | 30 | A completed move can be reversed for this long. |
| `recommendationThreshold` | 3 | A suggestion appears after the same choice has been made this many times. |
| `readinessStableChecks` | 3 | A file is "finished" after 3 identical stat checks, 2 s apart. |

Changing a default only affects users who never chose a value for it — an
explicitly configured setting is always kept.

## Security model

Path safety is enforced in three layers (see `src/engine/pathSafety.ts`):

1. **Structure validation** — rejects null bytes, control chars, reserved
   Windows names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), dotfile names, invalid
   path characters (`<>:"/\|?*`), alternate data streams, UNC and device paths,
   and temp/download suffixes (`.crdownload`, `.part`, `.partial`, `.download`,
   `.tmp`, `.aria2`, etc.).
2. **Deny-path check** — refuses destinations inside Windows, Program Files,
   AppData, LocalAppData, the app's own user-data folder, and Windows Startup
   folders. Drive roots and the bare user profile are deliberately *not*
   denied: denying a drive root would make the app refuse to place anything
   anywhere, and denying the profile would deny MySort's own default
   destination root.
3. **Monitored-folder loop check** — refuses to move a file into its own
   source folder, into another monitored folder, or to a path that resolves
   inside a watched folder.

Absolute paths **never** come from the renderer. They only enter via the OS
folder picker (`dialog.showOpenDialog`), which returns a single-use grant that
expires in 5 minutes. The renderer sends the grant id; main consumes it and
validates the path. Rule destinations are relative by default; absolute
destinations are only possible with a grant.

Context isolation is ON, `nodeIntegration` is OFF, the renderer runs sandboxed,
and permission requests are denied (camera, mic, geolocation, notifications).
No Node APIs are exposed to the renderer — the preload bridge exposes only the
typed `MySortApi`. Every IPC payload is re-validated in main against a strict
zod schema, and every request returns a `Result<T>` envelope rather than
throwing across the bridge.

The database is never touched from a newer app version; if a database has a
schema version newer than the app, it refuses to open rather than silently
corrupting.

### The local index

Search and duplicate detection are backed by a local SQLite index of file
*metadata* — path, name, size, timestamps and an optional content hash.

- It never stores file contents.
- It is a **cache, not the authority**: every action on a search result
  re-checks the file on disk first, and a result whose file has since
  changed or vanished is reported as missing rather than acted on.
- It only reads folders you have chosen, and it honours excluded folders and
  excluded file types.
- It can be cleared and rebuilt at any time. **Clearing the index never
  deletes a file.**

## Quick start

```bash
cd desktop
npm install
npm run dev          # start with hot reload (Electron + Vite)
npm run build        # production bundle (out/)
npm run package      # build artifacts in dist/
```

Requires Node 18+ and a C++ build toolchain for `better-sqlite3` (Windows:
Visual Studio Build Tools with the `C++ desktop development` workload; macOS:
Xcode CLI tools; Linux: `python3 make gcc g++`).

## Project structure

```
desktop/
├── src/
│   ├── main/            # Electron main process (window, tray, lifecycle, orchestrator, IPC)
│   │   ├── index.ts     # app entry, single-instance lock, wiring
│   │   ├── orchestrator.ts
│   │   ├── window.ts
│   │   ├── tray.ts
│   │   ├── ipc.ts
│   │   ├── rulesService.ts
│   │   ├── settingsService.ts
│   │   ├── searchService.ts      # the local metadata index
│   │   ├── duplicateService.ts   # exact duplicate detection
│   │   ├── recommendationService.ts
│   │   ├── collectionService.ts
│   │   ├── grants.ts
│   │   ├── logger.ts
│   │   └── notifications.ts
│   ├── preload/         # contextBridge + IPC forwarding
│   ├── renderer/        # React UI (spa, no routing library needed)
│   │   └── src/
│   │       ├── screens/ # Overview, Inbox, Rules, RuleDetail, Suggestions,
│   │       │           # History, Search, Duplicates, Collections, Settings, Setup
│   │       ├── components/
│   │       └── api.ts   # typed wrapper over window.api
│   ├── engine/          # pure, testable, no Electron/DB/React dependencies
│   │   ├── classify.ts
│   │   ├── rules.ts
│   │   ├── pathSafety.ts
│   │   ├── uniqueName.ts
│   │   ├── readiness.ts
│   │   ├── monitor.ts
│   │   ├── planner.ts
│   │   ├── executor.ts
│   │   ├── recovery.ts
│   │   ├── undo.ts
│   │   ├── indexer.ts        # the metadata indexer
│   │   ├── search.ts         # the search query model
│   │   ├── exclusions.ts     # what the index may not read
│   │   ├── duplicates.ts     # exact duplicate detection
│   │   ├── recommendations.ts
│   │   ├── renameTracking.ts
│   │   ├── renameWatcher.ts
│   │   └── fs.ts
│   ├── db/             # SQLite (better-sqlite3) with forward-only migrations
│   │   ├── database.ts
│   │   ├── migrations/       # 0001 init … 0005 collections/recommendations
│   │   └── repositories/      # operations, folders, rules, settings, index,
│   │                         # collections, recommendations
│   └── shared/         # types, zod schemas, error model (importable from any layer)
├── scripts/            # build-time tools (not shipped in the app)
│   ├── generate-icons.mjs   # logo.svg -> icon.png / icon.ico / tray icons
│   └── copy-assets.mjs      # copies runtime assets into out/main
├── electron.vite.config.ts
├── electron-builder.yml
└── tsconfig.json
```

## Dev

```bash
npm run dev
```

The dev server runs Vite in the renderer and Electron in main/preload. The
renderer uses the Vite dev server URL in dev; production loads from disk.

## Icons and assets

`logo.svg` is the single source of truth for the mark. The raster assets are
generated from it:

```bash
npm run icons      # writes assets/icon.png, assets/icon.ico, assets/tray*.png
```

`scripts/generate-icons.mjs` rasterises the SVG itself (scanline fill with
sub-pixel sampling) and encodes the PNGs with Node's built-in `zlib` — no image
dependency is added to the application. `scripts/copy-assets.mjs` copies the
runtime assets (the tray icons) into `out/main/assets/` after the build, so
the packaged application is self-contained.

## Build

```bash
npm run build      # emits out/main, out/preload, out/renderer
npm run package    # runs build + electron-builder --dir (unpacked)
npm run dist       # runs build + electron-builder --win nsis (installer)
npm run smoke      # launches the packaged app against an isolated profile
```

The build uses `electron-vite` which bundles main/preload with Rollup (Node
resolution, `externalizeDepsPlugin`) and the renderer with Vite + React
plugin. The preload is built as CJS `index.js` so `createMainWindow` can point
at `path.join(__dirname, '../preload/index.js')`.

The renderer is built with `base: './'` and without Vite's `crossorigin`
attribute: the renderer is loaded from a `file://` URL, and Chromium refuses
cross-origin requests from a `file://` origin, which would abort the module
and leave a blank window.

### Release smoke test

`npm run smoke` launches the packaged application with an isolated
`--user-data-dir` and a temporary watched folder, waits for it to start,
checks the log for errors, and confirms the watched file was left untouched.
It never points the app at the real Downloads folder, and it never deletes
user data.

> **Windows SmartScreen note:** the installer is currently unsigned, so Windows
> may show "Windows protected your PC". Click **More info → Run anyway**. This is
> expected for an unsigned build. Signed builds remove this prompt.

## Packaging

`electron-builder.yml` builds installers for Windows, macOS and Linux:

- **Windows (x64)**: NSIS installer (`MySort-Setup.exe`), `oneClick: false`,
  `perMachine: false`, Desktop + Start Menu shortcuts, app data preserved on
  uninstall.
- **macOS (universal)**: DMG and ZIP (`MySort.dmg`, `MySort.zip`).
- **Linux (x64)**: AppImage and deb (`MySort.AppImage`, `MySort.deb`).

Common to all targets: `better-sqlite3` unpacked from ASAR (native binary),
icons generated from `logo.svg`. Build with `npm run dist:win`,
`npm run dist:mac`, `npm run dist:linux` (or `npm run dist:ci` on macOS/Linux). macOS and
Linux packages must be built on their respective hosts (or via CI) because of
the native module and code-signing requirements.

## Tests

```bash
npm test           # vitest run
npm run test:watch
```

Tests are in `tests/` and run in Node environment with `pool: 'forks'`. The
engine layer is fully testable without Electron. Filesystem tests use
temporary directories and in-memory databases; they never touch real user
directories.

| File | Covers |
| --- | --- |
| `classify.test.ts` | extension normalization, compound suffixes, category lookup |
| `path-safety.test.ts` | structure validation, eligibility, name sanitizing |
| `deny-paths.test.ts` | the deny list protects the right places and no others |
| `executor.test.ts` | rule precedence, path structure, planner |
| `e2e-organize.test.ts` | real files + real SQLite: plan → move → journal → undo |
| `history-pagination.test.ts` | total ordering, filtered totals, no dropped rows |
| `rename-tracking.test.ts` | live and offline rename pairing |
| `search.test.ts` | the query model, LIKE escaping, fuzzy matching, relevance |
| `indexer.test.ts` | walking, exclusions, symlinks, cancellation, errors |
| `index-repo.test.ts` | the index schema, queries, hash invalidation, collections |
| `duplicates.test.ts` | size filtering, hash confirmation, conservative savings |
| `exclusions.test.ts` | what the index may and may not read |
| `recommendations.test.ts` | thresholds, stable fingerprints, evidence wording |
| `database-migrations.test.ts` | forward-only migrations, backups, newer-version refusal |

## TypeScript

```bash
npm run typecheck   # tsc --noEmit on both tsconfigs
npm run lint        # eslint with boundary rules (engine may not import Electron/React/DB; renderer may not import Node/Electron/engine/db/main)
```

## Troubleshooting

### Database won't open

If the app refuses to start with a database error, the database file at
`%APPDATA%/MySort/mysort.db` may be from a newer version or corrupted. Rename
it (don't delete) and restart:

```
move %APPDATA%\MySort\mysort.db %APPDATA%\MySort\mysort.db.bak
```

### Electron binary download fails

The build needs `electron` 44.8.0. If the download fails (network/proxy),
retry:

```bash
cd desktop
npm install --ignore-scripts
cd node_modules/electron
node install.js
```

Or set a mirror:

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

### Native module rebuild

If `better-sqlite3` fails to load (wrong Node ABI, moved folders, etc.):

```bash
npm run rebuild:native   # runs npm rebuild better-sqlite3
```

Or manually:

```bash
cd desktop
node node_modules/better-sqlite3/install.js
npm rebuild better-sqlite3
```

### "database schema vX is newer than this app"

This is intentional. The app refuses to open databases from newer versions. To
proceed, either upgrade the app or move the database out of the way. The old
database is backed up before any migration runs.

### Logs

Logs are written to `%APPDATA%/MySort/logs/` via `electron-log`. The level
defaults to `info`. Enable `debug` in Settings → Diagnostics to see file names
for troubleshooting; debug auto-reverts to `info` after 24 hours.

## License

MIT
