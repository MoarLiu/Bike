# Bike iOS

Bike iOS is the native SwiftUI companion aligned with Bike Android `0.1.13-ios-ux-alignment`.

## Current Scope

- Native SwiftUI app shell.
- Local-first Workspace v1 JSON model.
- Unknown-field-preserving JSON round trip for desktop compatibility.
- Document library with two-column layout, All / Shortcuts filters, search, long-press actions, rename, duplicate, shortcut toggle, and delete.
- Outline detail view with nested indentation, inline editing, checkbox, collapse/expand, sibling/child creation, outdent, deletion, keyboard accessory controls, and system back navigation.
- AI settings and AI node actions using the same Responses / Chat Completions parsing behavior inherited from desktop Bike and Android `0.1.12`.

Deferred from this beta, matching the Android plan:

- Mind map editing.
- MCP.
- Automatic sync.
- Drag sorting and richer multi-node outline operations.
- Full rich-text field editing.

## Project Shape

This repository is a SwiftPM package plus a minimal Xcode app project for simulator debugging.

- `Sources/BikeCore`: Foundation-only models, JSON compatibility, mutations, repository, AI parsing/service.
- `Sources/BikeiOSApp`: SwiftUI iOS app source.
- `Sources/BikeCoreChecks`: executable regression checks for the current Command Line Tools environment.
- `BikeiOS.xcodeproj`: Xcode app project with `BikeCore.framework` and `BikeiOS.app` targets.
- `BikeiOS.xcworkspace`: optional Xcode workspace pointing at the Swift package.

For Codex Build iOS Apps plugin debugging, the machine needs full Xcode selected and an iOS simulator runtime installed:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -downloadPlatform iOS
```

The simulator runtime can also be installed from Xcode > Settings > Components.

## Commands

```bash
swift build
swift run BikeCoreChecks
xcodebuild -list -project BikeiOS.xcodeproj
xcodebuild -project BikeiOS.xcodeproj -scheme BikeiOS -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/BikeIOSXcodeDerived build CODE_SIGNING_ALLOWED=NO
```
