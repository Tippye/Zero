# Zero Mail Android

Android 1.0.1 connects to an existing Zero Compose server. The checked-in Java/Gradle project is in [`android`](android). The separate Capacitor configuration is retained for the experimental iOS scaffold only; do not run `cap add android` or `cap sync android` over the Android client.

See the [Chinese Android guide](README.zh-CN.md) for installation, server configuration, features, release signing, and validation.

## Build Android

Requires JDK 17, Android SDK Platform 35 and Build Tools 35.0.0. Set `ANDROID_HOME` or create `android/local.properties` with `sdk.dir=/absolute/path/to/sdk`.

```sh
cd native/mobile
npm test
npm run android:check
```

No npm install, frontend build, embedded server credentials, or Capacitor installation is required for Android. Gradle Wrapper 8.11.1 includes the official distribution checksum. Windows runs the checked-in `gradlew.bat` through the npm commands.

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It is signed with a development key. For a release APK/AAB, configure your signing environment as documented and run `npm run android:release`. Signing keys and build outputs are excluded from Git.

## Supported behavior

- Native server settings; HTTP requires explicit consent. Pairing code / QR login uses the server's same-origin page and HttpOnly cookies. Approve the first device from the server terminal; see the [pairing guide (中文)](../../deploy/AUTHENTICATION.zh-CN.md).
- Mail UI, compose, attachments, and settings come from the connected server.
- No persistent native back/menu toolbar. System back cannot return from mail to login; keyboard/system-bar insets, system theme, and connection/certificate error recovery are supported.
- Cold/warm `mailto:` and `zeromail://compose`/`zeromail://inbox` intents, plus Android text sharing to compose.
- System document picker for uploads and saves; bounded 25 MB blob/data attachment downloads through a main-frame, exact-origin message listener. No unrestricted JavaScript interface.
- Opt-in background mail checks through JobScheduler and the existing authenticated `/api/desktop/events` endpoint. The minimum interval is 15 minutes; delivery depends on Android scheduling, network and battery policy. Notifications hide mail contents.
- Local session/cache cleanup on server changes and from Settings → General → Android app settings. No cloud backup or device transfer of the app's private data.

This version requires network access. It does not provide an offline send queue, FCM real-time push, or native Google OAuth handoff. Connect Gmail in a system browser while signed in to the same Zero server account, then use that account in the Android client. Browser and WebView sessions are separate. Only the configured server is navigated inside the mail WebView; external links with a user gesture open in another app.

## Tests

`npm test` covers the existing iOS asset preparation and Android attachment JavaScript. `npm run android:check` runs URL-policy JVM tests, Android Lint, and builds the app and device test APKs. `npm run android:device-test` runs the instrumented tests against an emulator or connected test device. These tests reset **this app's data on the test device** and use a local synthetic HTTP server; they do not send mail or connect to a production mailbox.

The Android GitHub workflow builds, tests on an API 35 emulator, and uploads a debug APK and reports. It does not publish to an app store.

## Experimental iOS scaffold

The original `prepare:web`, `add:ios`, `sync`, and `open:ios` commands still prepare bundled web assets for the legacy Capacitor iOS scaffold. New Apple development uses the separate [SwiftUI/Xcode project](../apple/README.md), including pairing authentication and Keychain storage; Xcode builds and device validation remain pending. See the [Mac migration guide (中文)](../apple/MIGRATION.zh-CN.md).
