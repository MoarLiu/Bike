# Bike Mobile Platform Matrix

Bike mobile clients are companion apps for the desktop product. They should keep the same Workspace JSON semantics and product language, but they do not need desktop feature parity.

## Current Beta Scope

| Feature | Desktop Web/Electron | macOS Swift Native | Android Companion | iOS Companion |
| --- | --- | --- | --- | --- |
| Workspace v1 JSON | Yes | Yes | Yes | Yes |
| Preserve unknown JSON fields | Yes | Yes | Yes | Yes |
| Document library | Yes | Yes | Yes | Yes |
| Document rename/delete/duplicate | Yes | Yes | Yes | Yes |
| Outline reading | Yes | Yes | Yes | Yes |
| Light outline editing | Yes | Yes | Yes | Yes |
| Checkbox / completed state | Yes | Yes | Yes | Yes |
| Child visual inheritance from completed parent | Platform-dependent | Platform-dependent | Yes | Planned |
| Search | Yes | Yes | Yes | Yes |
| Import/export workspace JSON | Yes | Yes | Yes | Local repository support |
| Share target / quick capture | No | No | Yes | Planned |
| AI generate children | Yes | Yes | Yes | Yes |
| AI polish node | Yes | Yes | Yes | Yes |
| Responses endpoint | Yes | Yes | Yes | Yes |
| Chat Completions endpoint | Yes | Yes | Yes | Yes |
| Mind map view | Yes | Yes | Deferred | Deferred |
| MCP | Yes | Planned / partial | Deferred | Deferred |
| Automatic sync | No | iCloud backup path | Deferred | Deferred |
| Drag sorting | Yes | Yes | Deferred | Deferred |
| Multi-node outline batch ops | Yes | Yes | Deferred | Deferred |
| Full rich-text field editing | Yes | Yes | Deferred | Deferred |

## Positioning

Mobile apps should optimize for:

- Capturing ideas away from the desk.
- Reading and lightly editing existing outlines.
- Creating siblings and children quickly from the keyboard.
- Running AI generate/polish actions with the same parsing tolerance as desktop.
- Preserving desktop-created data even when mobile does not expose every field.

Mobile apps should not block beta release on:

- Mind map editing.
- MCP integration.
- Automatic sync.
- Drag sorting.
- Full rich-text controls.

## Repository Rules

- Keep mobile source under `apps/android` and `apps/ios`.
- Keep generated build outputs out of git: APK, IPA, dSYM, zip, build directories, local SDK paths, and local signing files.
- Publish installable artifacts through GitHub Releases with release notes and SHA-256 checksums.
- Use platform-specific tags for release artifacts, for example `android-v0.1.13` and `ios-v0.1.13`.
- Do not store API keys, local workspace files, provisioning profiles, keystores, or signing certificates in the repository.

## Signing Notes

Android beta packages may be debug-signed for sideload testing, but production Play distribution requires a release keystore.

iOS simulator builds can be shared for simulator testing. Physical-device IPA distribution requires Apple Developer signing and a matching provisioning profile.
