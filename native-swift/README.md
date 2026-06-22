# Bike Native

原生 Swift/macOS 版本放在本目录内，和仓库根目录的 Electron/Web 版本并行存在。这里的代码、脚本、测试和打包产物都不覆盖现有 `src/`、`electron/`、`server/`、`package.json`。

## Current Shape

- Minimum target: macOS 15+
- Bundle id: `com.bike.native`
- Runtime: SwiftUI + AppKit bridges, with Markdown files plus a sidecar metadata file as the primary storage
- Compatibility format: current `Workspace version: 1` JSON
- Markdown storage path: `~/Library/Mobile Documents/com~apple~CloudDocs/Bike/`
- JSON backup path: `~/Library/Mobile Documents/com~apple~CloudDocs/Bike/.backups/`
- Web Sync: manual document-level sync through a deployed Bike Web service

## 1.4.x parity

- Product name, bundle metadata, iCloud paths, and release script defaults are aligned with Bike 1.4.x.
- The app menu, toolbar, and settings expose API key configuration and update checking.
- The sidebar, settings, and Bike menu expose Web Sync configuration and manual sync actions.
- Outline, mind map, and Markdown modes expose AI generate/polish actions.
- AI provider compatibility matches the Electron/Web implementation: Responses input uses a list, Chat/completions is supported, HTML endpoint mismatches show a clear error, Responses SSE text streams are parsed, and generated children accept flexible JSON keys such as `children`, `nodes`, `items`, `topics`, `title`, `name`, and `label`.
- The main window defaults to `1366 × 960` with a minimum size of `980 × 640`.

This workspace currently uses SwiftPM. `scripts/build_and_run.sh` builds a native `.app` bundle under `native-swift/dist/`. The release script writes a local DMG under `native-swift/release/`; build outputs are ignored by `native-swift/.gitignore`.

## Persistence / Backup

- `Sources/BikeNative/Persistence/WorkspaceRepository.swift` owns workspace load/save, debounced-save persistence targets, iCloud Drive Markdown storage, sidecar metadata, legacy JSON migration, snapshot creation/listing, and snapshot restore.
- `Sources/BikeNative/Services/AppStore.swift` debounces autosave with a cancellable `Task.sleep`.
- `Sources/BikeNative/Services/BackupService.swift` contains `ICloudBackupService` and `FilePanelService`.
- `Sources/BikeNative/Services/SyncService.swift` contains the Bike Web Sync API client, plain UserDefaults sync settings, revision state, and document-level merge/conflict logic.
- `Sources/BikeNative/Core/SelfTestRunner.swift` covers JSON compatibility, repository save/load, snapshots, restore, and iCloud backup file behavior.

## Web Sync

After deploying Bike Web with `sync.enabled: true`, open Web Sync from the sidebar gear, Settings, or the Bike menu. Enter the deployed Web URL and the device sync key configured in `sync.deviceTokenHashes`.

- `保存并同步` runs document-level bidirectional sync.
- `上传` initializes or replaces remote documents from this Mac, guarded by expected revisions.
- `拉取` replaces the local workspace from Web after creating a local snapshot.
- `后台自动同步` runs after local saves and on the configured interval; quiet no-op syncs do not show notices.

The device key, server URL, and revision checkpoints are stored plainly in UserDefaults. Bike Native does not read the macOS Keychain for Web Sync.

## Commands

```bash
./scripts/build_and_run.sh
./scripts/test_all.sh
./scripts/package_dmg.sh
```

Useful variants:

```bash
./scripts/build_and_run.sh --verify
./scripts/build_and_run.sh --logs
VERSION=1.4.1 ./scripts/package_dmg.sh
CODE_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./scripts/package_dmg.sh
```

`package_dmg.sh` creates an unsigned/ad-hoc local DMG by default. Developer ID signing, notarization, and stapling require a full Xcode install and Apple Developer credentials.
