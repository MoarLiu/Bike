# Bike Android

Bike Android is the native Android companion for Bike. The first milestone is
focused on local-first workspace compatibility, fast capture, reading, and light
outline editing rather than full desktop parity.

## MVP Direction

- Native Kotlin + Jetpack Compose app.
- Compatible with Bike `Workspace` version 1 JSON.
- Wide-read and preserve desktop fields that Android does not edit yet.
- Start with document list, search, import/export, outline light editing, and
  Markdown reading/editing.
- Defer full mind map editing, MCP, automatic sync, and advanced exporters.

## Current State

This repository currently contains a first usable vertical slice:

- Compose app shell.
- Local workspace creation and persistence in the app private directory.
- SAF-based workspace JSON import/export.
- Android text share target that appends shared content to the Bike Android inbox.
- Document list and active document switching.
- Basic outline rendering with nested indentation.
- Outline search across topic text and notes, including collapsed descendants.
- Light outline editing: text, note, checkbox, collapse/expand, sibling/child insert,
  and node deletion.
- Node text/note edits update the workspace immediately and are persisted through
  the debounced local save pipeline.
- AI settings stored locally outside workspace JSON.
- AI node actions: generate children and polish current node through an
  OpenAI-compatible chat/completions endpoint.
- AI API keys are encrypted with Android Keystore and old plaintext settings are
  migrated on first load.
- Debounced local saves, corrupted workspace backup, and duplicate share-ingest
  protection after activity recreation.
- Review hardening: AI network connections are closed on exception paths, and
  topic text/note saves are applied as one workspace mutation.
- Workspace JSON round-trip tests that preserve unknown desktop fields.
- Workspace imports are validated so an empty document list cannot leave the app
  stuck on an unrenderable local file.
- Local workspace writes are serialized, and UI mutations are reduced from the
  latest in-memory payload to avoid stale-event overwrites.
- Orientation/screen-size changes are handled without recreating the activity,
  preserving pending debounced saves and in-progress UI state.
- Cleartext HTTP AI endpoints are limited by Android network security config to
  loopback/emulator hosts (`localhost`, `127.0.0.1`, `10.0.2.2`, `10.0.3.2`);
  LAN or public self-hosted endpoints should use HTTPS. AI settings are excluded
  from Android Auto Backup because their encryption key is device-local.
- AI network and HTTP errors are mapped to user-facing messages for common
  configuration, timeout, auth, rate-limit, and service-unavailable cases.

## Build

Install Android Studio or configure a JDK and Android SDK, then run:

```bash
./gradlew test
./gradlew assembleDebug
```

The debug APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Release builds enable R8 shrinking with the app ProGuard rules:

```bash
./gradlew assembleRelease
```

This workspace has been verified locally with:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH \
./gradlew test

JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH \
./gradlew assembleDebug
```
