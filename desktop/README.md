# MySort

Every file. In its place. MySort watches your Downloads folder and sorts new files for you. Everything stays on this computer.

## What it does

- **Monitors** your chosen folder for finished downloads (skips in-progress files, hidden files, and folders).
- **Classifies** files by extension into categories (Images, Videos, Documents, Audio, Archives, other).
- **Orders rules** by position; the first matching enabled rule wins.
- **Previews** every planned move so you can review before anything happens.
- **Applies** approved moves with an intent log and a stable-fingerprint gate (stable stats, 800 ms apart) before touching a file.
- **Recovers** interrupted moves on next startup (checked via `OperationsRepo.findUnfinished`).
- **Undoes** completed moves within the undo window (configurable, default 30 days), with auto-rename when the original name is taken.
- **Stays local**: no network, no telemetry, no outbound requests.

## Security model

Path safety is enforced in three layers (see `src/engine/pathSafety.ts`):

1. **Structure validation** — rejects null bytes, control chars, reserved Windows names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), dotfile names, invalid path characters (`<>:"/\|?*`), and temp/download suffixes (`.crdownload`, `.part`, `.partial`, `.download`, `.tmp`, `.aria2`, etc.).
2. **Deny-path check** — refuses destinations inside Windows, Program Files, user profile, AppData, LocalAppData, the app's own user-data folder, and Windows Startup folders.
3. **Monitored-folder loop check** — refuses to move a file into its own source folder, into another monitored folder, or to a path that resolves inside a watched folder.

Absolute paths **never** come from the renderer. They only enter via the OS folder picker (`dialog.showOpenDialog`), which returns a single-use grant that expires in 5 minutes. The renderer sends the grant id; main consumes it and validates the path. Rule destinations are relative by default; absolute destinations are only possible with a grant.

Context isolation is ON, `nodeIntegration` is OFF, the renderer runs sandboxed, and permission requests are denied (camera, mic, geolocation, notifications). No Node APIs are exposed to the renderer — the preload bridge exposes only the typed `MySortApi`.

The database is never touched from a newer app version; if a database has a schema version newer than the app, it refuses to open rather than silently corrupting.

## Quick start

```bash
cd desktop
npm install
npm run dev          # start with hot reload (Electron + Vite)
npm run build        # production bundle (out/)
npm run package      # build artifacts in dist/
```

Requires Node 18+ and a C++ build toolchain for `better-sqlite3` (Windows: Visual Studio Build Tools with the `C++ desktop development` workload; macOS: Xcode CLI tools; Linux: `python3 make gcc g++`).

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
│   │   ├── grants.ts
│   │   ├── logger.ts
│   │   └── notifications.ts
│   ├── preload/         # contextBridge + IPC forwarding
│   ├── renderer/        # React UI (spa, no routing library needed)
│   │   └── src/
│   │       ├── screens/ # Onboarding, Overview, Rules, Preview, History, Settings, Recovery
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
│   │   └── fs.ts
│   ├── db/             # SQLite (better-sqlite3) with forward-only migrations
│   └── shared/         # types, zod schemas, error model (importable from any layer)
├── electron.vite.config.ts
├── electron-builder.yml
└── tsconfig.json
```

## Dev

```bash
npm run dev
```

The dev server runs Vite in the renderer and Electron in main/preload. The renderer uses the Vite dev server URL in dev; production loads from disk.

## Build

```bash
npm run build      # emits out/main, out/preload, out/renderer
npm run package    # runs build + electron-builder --dir (unpacked)
npm run dist       # runs build + electron-builder --win nsis (installer)
```

The build uses `electron-vite` which bundles main/preload with Rollup (Node resolution, `externalizeDepsPlugin`) and the renderer with Vite + React plugin. The preload is built as CJS `index.js` so `createMainWindow` can point at `path.join(__dirname, '../preload/index.js')`.

## Packaging

`electron-builder.yml` builds a NSIS installer for Windows x64 with:

- `oneClick: false`, `perMachine: false`
- Desktop + Start Menu shortcuts
- App data preserved on uninstall
- `better-sqlite3` unpacked from ASAR (native binary)
- Artifact: `MySort-Setup.exe`

## Tests

```bash
npm test           # vitest run (unit tests for classify, rules, pathSafety, executor)
npm run test:watch
```

Tests are in `tests/` and run in Node environment with `pool: 'forks'`. The engine layer is fully testable without Electron.

## TypeScript

```bash
npm run typecheck   # tsc --noEmit on both tsconfigs
npm run lint        # eslint with boundary rules (engine may not import Electron/React/DB; renderer may not import Node/Electron/engine/db/main)
```

## Troubleshooting

### Database won't open

If the app refuses to start with a database error, the database file at `%APPDATA%/MySort/mysort.db` may be from a newer version or corrupted. Rename it (don't delete) and restart:

```
move %APPDATA%\MySort\mysort.db %APPDATA%\MySort\mysort.db.bak
```

### Electron binary download fails

The build needs `electron` 44.8.0. If the download fails (network/proxy), retry:

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

This is intentional. The app refuses to open databases from newer versions. To proceed, either upgrade the app or move the database out of the way. The old database is backed up before any migration runs.

### Logs

Logs are written to `%APPDATA%/MySort/logs/` via `electron-log`. The level defaults to `info`. Enable `debug` in Settings → Diagnostics to see file names for troubleshooting; debug auto-reverts to `info` after 24 hours.

## License

MIT
