# GravityBox Screenshot Assets

This directory contains all **60 high-DPI (2x Retina) screenshots** referenced by [`README.md`](../../README.md) (English default) and [`README.zh-CN.md`](../../README.zh-CN.md) (Simplified Chinese), with automatic Light and Dark appearance pairs.

## Privacy Sanitization

All accounts, emails, quotas, and token metrics are generated from isolated synthetic test fixtures (`Alex`, `Bob`, `Charlie` on `@example.invalid`, plus synthetic HUD sessions). No personal credentials, local workspace names, or production account data are included.

## Generation Pipeline

- **Native macOS AppKit Windows & Menu Bar Panel** (`40 PNGs`: 20 English `en-*.png` + 20 Chinese): captured via `npm run test:native-ui` in headless isolation and composited with macOS window framing and Hero backdrops by `swift tools/generate-screenshots.swift`.
- **In-IDE Telemetry HUD** (`20 PNGs`: 10 English `en-hud*.png` + 10 Chinese `hud*.png`): rendered with the real compiled `dist/engine.js` (`runtime/hud-*.js`) inside headless Chromium at `deviceScaleFactor: 2` via `node tools/capture-hud-screenshots.mjs`.

## Asset Index

| Surface | English (Light / Dark) | Simplified Chinese (Light / Dark) | Resolution |
| :--- | :--- | :--- | :--- |
| **Hero Composite** | `en-hero.png` / `en-hero-dark.png` | `hero.png` / `hero-dark.png` | `2560×1440` |
| **Telemetry HUD Overview** | `en-hud.png` / `en-hud-dark.png` | `hud.png` / `hud-dark.png` | `2160×1080` |
| **HUD Capsules Close-Up** | `en-hud-capsules.png` / `en-hud-capsules-dark.png` | `hud-capsules.png` / `hud-capsules-dark.png` | `1600×352` |
| **HUD · Session Stats** | `en-hud-card-session.png` / `en-hud-card-session-dark.png` | `hud-card-session.png` / `hud-card-session-dark.png` | `1760×840` |
| **HUD · Token Usage** | `en-hud-card-tokens.png` / `en-hud-card-tokens-dark.png` | `hud-card-tokens.png` / `hud-card-tokens-dark.png` | `1760×840` |
| **HUD · Current Context** | `en-hud-card-context.png` / `en-hud-card-context-dark.png` | `hud-card-context.png` / `hud-card-context-dark.png` | `1760×880` |
| **Main · Overview** | `en-overview.png` / `en-dark-overview.png` | `overview.png` / `dark-overview.png` | `2200×1520` |
| **Main · Accounts** | `en-accounts.png` / `en-dark-accounts.png` | `accounts.png` / `dark-accounts.png` | `2200×1520` |
| **Main · Usage** | `en-usage.png` / `en-dark-usage.png` | `usage.png` / `dark-usage.png` | `2200×1520` |
| **Main · Settings** | `en-settings.png` / `en-dark-settings.png` | `settings.png` / `dark-settings.png` | `2200×1520` |
| **Main · About** (`about.png`, `v1.2.0`) | `en-about.png` / `en-dark-about.png` | `about.png` / `dark-about.png` | `2200×1520` |
| **Menu Bar · Usage** | `en-menubar.png` / `en-dark-menubar.png` | `menubar.png` / `dark-menubar.png` | `848×1280` |
| **Menu Bar · Quota** | `en-menubar-quota.png` / `en-dark-menubar-quota.png` | `menubar-quota.png` / `dark-menubar-quota.png` | `848×994` |
| **Menu Bar · Accounts** | `en-menubar-accounts.png` / `en-dark-menubar-accounts.png` | `menubar-accounts.png` / `dark-menubar-accounts.png` | `848×1082` |
| **Storage & Maintenance** | `en-maintenance.png` / `en-dark-maintenance.png` | `maintenance.png` / `dark-maintenance.png` | `1284×928` / `1240×928` |
