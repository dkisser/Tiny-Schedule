# Tiny-Schedule

> A local-first task manager + AI-powered desktop app built on Electron. One-click import from Super Productivity backups.

[简体中文](./README.md) · [English](#)

[![GitHub release](https://img.shields.io/github/v/release/dkisser/Tiny-Schedule?include_prereleases&sort=semver)](https://github.com/dkisser/Tiny-Schedule/releases)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-blueviolet)](https://github.com/dkisser/Tiny-Schedule/releases)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.2-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![GitHub stars](https://img.shields.io/github/stars/dkisser/Tiny-Schedule)](https://github.com/dkisser/Tiny-Schedule/stargazers)

---

## Table of Contents

- [Why Tiny-Schedule?](#why-tiny-schedule)
- [Features](#features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Importing from Super Productivity](#importing-from-super-productivity)
- [AI Providers & Custom Prompts](#ai-providers--custom-prompts)
- [Development](#development)
- [Build & Release](#build--release)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Why Tiny-Schedule?

A local-first Electron desktop app for people who want **complete ownership of their tasks and time**. Tiny-Schedule combines a fast keyboard-driven task manager with **AI-powered daily / weekly reports**, so you can focus on doing the work instead of reviewing what you did.

- 📦 **Local-first**: All task data lives in a local SQLite database. No cloud required (except your explicitly configured AI provider).
- ⌨️ **Keyboard-driven**: Inspired by Super Productivity and Things.
- 🤖 **AI insights**: Multiple OpenAI-compatible providers (OpenAI, DeepSeek, Azure, self-hosted, Ollama). One-click daily/weekly reports.
- 🔁 **Portable**: Full backup-JSON import from Super Productivity with auto-backup. Never get locked in.
- 📤 **Exportable**: Markdown worklogs and project task lists — drop into Notion, Obsidian, or your blog.

### Comparison

| Aspect | Tiny-Schedule | Super Productivity | Things 3 | TickTick |
|---|---|---|---|---|
| Local-first | ✅ | ✅ | ✅ | ❌ Cloud-only |
| AI daily/weekly reports | ✅ Multi-provider | ❌ | ❌ | ⚠️ Cloud-only |
| Super Productivity migration | ✅ Full import | — | ❌ | ❌ |
| Markdown export | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Open source | ✅ Apache-2.0 | ✅ MIT | ❌ | ❌ |
| Platform | macOS | Cross-platform | macOS / iOS | Cross-platform |

---

## Features

### 📋 Task management
- Projects / Tags / Today / Upcoming / Subtasks
- Subtask hierarchy and completion progress
- Notes and recurring tasks
- Drag-to-reorder

### ⏱ Time tracking
- Per-task active timer; auto-pauses on window hide / system sleep
- Time history with review and stats

### 🤖 AI analysis
- Daily reports, periodic reviews
- Multiple OpenAI-compatible providers (configure API key, base URL, model in Settings)
- Custom prompt templates
- Streaming output with chat-style view

### 📥 Import
- Full Super Productivity backup-JSON import
- Auto-backup before overwriting

### 📤 Export
- Markdown project task list
- Markdown worklog (with timer details)

### 🎨 Theme
- Light / Dark / Follow system
- Unified UI conventions (buttons, icons, spacing — see `docs/ui-guidelines.md`)

### ⚙️ Misc
- Settings page: user info, AI providers, custom prompts
- Auto-update checks against GitHub Releases

---

## Screenshots

> 📌 **Screenshot placeholders.** When contributing, drop images into `docs/screenshots/` and reference them here.
> Recommended size: 1280×800 PNG or WebP. Suggested names: `today.png` / `ai.png` / `settings.png` / `export.png`.

```markdown
<!-- Uncomment after dropping images -->
<!-- ![Today](docs/screenshots/today.png) -->
<!-- ![AI Daily Report](docs/screenshots/ai.png) -->
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| Desktop shell | [Electron 43](https://www.electronjs.org/) + [electron-vite](https://electron-vite.org/) |
| Renderer | React 19 + TypeScript 5.7 |
| Styling | Tailwind CSS 4 + Radix UI + lucide-react |
| State | Zustand 5 |
| Data | Local SQLite (via IPC) |
| AI | [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) (multi-provider, OpenAI-compatible) |
| Markdown | cherry-markdown / react-markdown / remark-gfm |
| Packaging | electron-builder (DMG, macOS arm64 + x64) |
| Toolchain | Bun ≥ 1.2 · Biome 2 · TypeScript Project References |
| Testing | Bun Test |

---

## Quick Start

> macOS only (GitHub Releases ship arm64 + x64 DMGs). Other platforms require building from source.

1. Go to [Releases](https://github.com/dkisser/Tiny-Schedule/releases) and download the latest `.dmg`.
2. Mount the DMG and drag `Tiny Schedule.app` into Applications.
3. On first launch, macOS Gatekeeper may block the unsigned app:
   - **Recommended**: In Applications, **right-click** `Tiny Schedule.app` → **Open** → confirm.
   - **Permanent fix**: Quit the app first, then run `sudo xattr -rd com.apple.quarantine "/Applications/Tiny Schedule.app"`.
4. Open **Settings** → fill in your AI provider (API key, base URL, model) to enable AI analysis.

> 📥 Already on Super Productivity? See [Importing from Super Productivity](#importing-from-super-productivity).

---

## Importing from Super Productivity

Tiny-Schedule supports **full-database import** of Super Productivity backup JSON:

1. In Super Productivity, export a backup JSON (Settings → Backup).
2. In Tiny-Schedule, open Settings → Import and pick that JSON.
3. Tiny-Schedule auto-backs up your current data, then overwrites with SP data.
4. Tasks, projects, tags, subtasks, and timer history become available immediately.

> ⚠️ Import is **whole-database replace**, not a merge. Auto-backup happens before the overwrite; you can roll back if needed.

---

## AI Providers & Custom Prompts

In **Settings → AI Provider**:

- **Multi-provider**: any OpenAI-compatible endpoint (OpenAI, DeepSeek, Azure OpenAI, self-hosted, Ollama).
- **API key / base URL / model** combinations.
- **Connection test** button built in.
- **Custom prompts**: define your own daily/weekly/review templates.

The built-in chat view streams output chunk-by-chunk, ChatGPT-style.

---

## Development

Requires **Node.js ≥ 20** and **Bun ≥ 1.2**.

```bash
bun install
bun run dev        # launch Electron dev environment
bun test           # run all tests
bun run lint       # Biome check
bun run typecheck  # TypeScript project references
```

This is a Bun-workspaces monorepo:

```
Tiny-Schedule/
├── packages/
│   ├── app/      # Electron main + renderer
│   └── shared/   # Shared types (Zod schemas)
├── scripts/      # Repo-level scripts (e.g. IPC literal checks)
├── docs/         # UI conventions, design notes
└── .github/      # GitHub Actions (release.yml only)
```

---

## Build & Release

### Local builds

```bash
bun run build      # produces packages/app/out
bun run release:dir   # unpack .app into packages/app/release/
bun run release      # build .dmg into packages/app/release/ (no publish)
```

> `release` defaults to `--publish never` for local verification; the publish step only runs in CI with `--publish always`.

### Publishing to GitHub Releases

Packaged by [electron-builder](https://www.electron.build/) and uploaded by GitHub Actions when you push a `v*` tag.

**Trigger with a tag**:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` runs on `macos-latest`: lint → typecheck → test → electron-vite build → electron-builder → produces `Tiny Schedule-<version>-arm64.dmg` and `Tiny Schedule-<version>-x64.dmg` → creates a GitHub Release and uploads the artifacts.

**First-time install (unsigned)**:

No Apple Developer ID signing or notarization, so Gatekeeper will block first launch. Pick one:

- **Right-click to open (recommended)**: Mount the `.dmg` → drag `Tiny Schedule.app` to Applications → in Applications, **right-click** `Tiny Schedule.app` → **Open** → confirm. Subsequent double-clicks work normally.
- **Strip the quarantine attribute (more thorough)**: Quit the app from Applications first, then run:

  ```bash
  sudo xattr -rd com.apple.quarantine "/Applications/Tiny Schedule.app"
  ```

  After that, double-click works normally.

---

## Roadmap

- [ ] Windows / Linux packaging (electron-builder config slot already reserved)
- [ ] Optional sync layer (self-hosted WebDAV / S3)
- [ ] Plugin system (custom prompts / custom exporters)
- [ ] i18n framework
- [ ] Social preview image

---

## Contributing

Contributions welcome. Please read before opening a PR:

- [`AGENTS.md`](./AGENTS.md) — UI conventions entry point
- [`docs/ui-guidelines.md`](./docs/ui-guidelines.md) — buttons / icons / spacing
- [`CLAUDE.md`](./CLAUDE.md) — Claude Code instructions for this repo

Suggested flow: fork → new branch → PR (commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)).

---

## License

[Apache-2.0](./LICENSE) © 2026 dkisser

---

## Acknowledgments

- [Super Productivity](https://github.com/johannesjo/super-productivity) — data model and UX inspiration
- [Electron](https://www.electronjs.org/) · [electron-vite](https://electron-vite.org/) · [electron-builder](https://www.electron.build/)
- [Radix UI](https://www.radix-ui.com/) · [Tailwind CSS](https://tailwindcss.com/) · [lucide-react](https://lucide.dev/)
- [Zustand](https://github.com/pmndrs/zustand)
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)
- [Cherry Markdown](https://github.com/Tencent/cherry-markdown) · [react-markdown](https://github.com/remarkjs/react-markdown)

If this project helps you, drop a ⭐ or share your thoughts in [Issues](https://github.com/dkisser/Tiny-Schedule/issues).