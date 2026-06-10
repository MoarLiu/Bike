# Local Outline Native

原生 Swift/macOS 版本放在本目录内，和仓库根目录的 Electron/Web 版本并行存在。这里的代码、脚本、测试和打包产物都不覆盖现有 `src/`、`electron/`、`server/`、`package.json`。

## Current Shape

- Minimum target: macOS 15+
- Bundle id: `com.localoutline.native`
- Runtime: SwiftUI + AppKit bridges, with Markdown files plus a sidecar metadata file as the primary storage
- Compatibility format: current `Workspace version: 1` JSON
- Markdown storage path: `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/`
- JSON backup path: `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/.backups/`

This workspace currently uses SwiftPM. `scripts/build_and_run.sh` builds a native `.app` bundle under `native-swift/dist/`. The release script writes a local DMG under `native-swift/release/`; build outputs are ignored by `native-swift/.gitignore`.

## Persistence / Backup

- `Sources/LocalOutlineNative/Persistence/WorkspaceRepository.swift` owns workspace load/save, debounced-save persistence targets, iCloud Drive Markdown storage, sidecar metadata, legacy JSON migration, snapshot creation/listing, and snapshot restore.
- `Sources/LocalOutlineNative/Services/AppStore.swift` debounces autosave with a cancellable `Task.sleep`.
- `Sources/LocalOutlineNative/Services/BackupService.swift` contains `ICloudBackupService` and `FilePanelService`.
- `Sources/LocalOutlineNative/Core/SelfTestRunner.swift` covers JSON compatibility, repository save/load, snapshots, restore, and iCloud backup file behavior.

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
VERSION=0.1.0 ./scripts/package_dmg.sh
CODE_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./scripts/package_dmg.sh
```

`package_dmg.sh` creates an unsigned/ad-hoc local DMG by default. Developer ID signing, notarization, and stapling require a full Xcode install and Apple Developer credentials.
