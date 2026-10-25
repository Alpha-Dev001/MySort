# MySort

[![Release](https://img.shields.io/github/v/release/Alpha-Dev001/MySort)](https://github.com/Alpha-Dev001/MySort/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/Alpha-Dev001/MySort/releases/latest)

Every file. In its place.

MySort watches a folder, waits until downloads finish, and organizes files by your rules.

**Privacy first.** MySort runs entirely on your computer. There is no account, no
telemetry, and no network access of any kind. Your files and index never leave
your machine. The full source code is open and auditable.

---

## Overview

MySort is a desktop application that monitors specified folders, waits for downloads to complete, and then organizes files according to user-defined rules. It helps keep your download and document folders tidy without manual intervention.

---

## Features

- **Folder monitoring**: Watch selected directories for new files
- **Download waiting**: Intelligently waits for download completion before organizing
- **Rule-based organization**: Apply custom rules to sort files into appropriate locations
- **Cross-platform**: Electron app for Windows, macOS and Linux

---

## Installation

### Using the installer

Download the latest build for your platform:

- **Windows**: <https://github.com/Alpha-Dev001/MySort/releases/latest/download/MySort-Setup.exe>
- **macOS (Intel)**: <https://github.com/Alpha-Dev001/MySort/releases/latest/download/MySort-x64.dmg>
- **macOS (Apple Silicon)**: <https://github.com/Alpha-Dev001/MySort/releases/latest/download/MySort-arm64.dmg>
- **Linux (AppImage)**: <https://github.com/Alpha-Dev001/MySort/releases/latest/download/MySort-x86_64.AppImage>
- **Linux (Debian/Ubuntu)**: <https://github.com/Alpha-Dev001/MySort/releases/latest/download/MySort-amd64.deb>

> **Windows SmartScreen note:** the installer is currently unsigned, so Windows
> may show "Windows protected your PC". **This is a standard Windows warning for
> unsigned software, not a virus alert.** Click **More info → Run anyway** to
> install. MySort is open source and contains no telemetry or network access.
> Future releases signed with a publisher certificate will remove this prompt.

Then run the installer / mount the DMG / make the AppImage executable and launch
MySort.

### Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build the application
npm run build

# Create distributable installer
npm run dist
```

---

## Usage

- Select folders to monitor via the application interface
- Define organization rules for different file types
- Let MySort run in the background to keep folders organized

---

## Technology Stack

- **Electron** – Desktop application framework
- **TypeScript** – Type-safe codebase
- **better-sqlite3** – Embedded database
- **React** – Renderer interface

---

## Project Structure

```
desktop/
  src/          – Source code
    main/       – Main process (Electron)
    renderer/   – Renderer process (React + Vite)
  scripts/      – Build and utility scripts
  assets/       – Icons and resources
```

---

## License

[MIT](LICENSE) – Copyright (c) 2026 MySort

---

## Contact

- GitHub: <https://github.com/Alpha-Dev001/MySort>