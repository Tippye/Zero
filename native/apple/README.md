# Zero Mail for Apple platforms

Native SwiftUI applications share the `ZeroPairing` authentication library and the `ZeroMail` mail library. Open **ZeroMail.xcodeproj** in Xcode 16 or later:

| Scheme    | Platform                                           | Minimum OS      |
| --------- | -------------------------------------------------- | --------------- |
| ZeroMac   | Native macOS, SwiftUI + AppKit/WebKit              | macOS 13        |
| ZeroIOS   | Universal iPhone and iPad application              | iOS / iPadOS 16 |
| ZeroWatch | Independent, single-target Apple Watch application | watchOS 9       |

**[迁移到 macOS、继续开发与验收说明](MIGRATION.zh-CN.md)** · **[验证记录](VALIDATION.zh-CN.md)**

The checked-in project includes application targets and shared schemes. No project generator or third-party Swift dependencies are needed to open or build it. `scripts/generate-project.rb` is only for deliberate project regeneration; it uses `xcodeproj` 1.27.0 and overwrites project settings.

Implemented source includes device pairing and management, mailbox selection, search and pagination, thread reading, read/star/archive/trash actions, composing/replying, mailbox drafts, attachments, Handoff routing, `mailto:` / `zeromail:` links, and an App Intent that opens the composer for review. Watch has a separate compact reading and reply UI. Server account setup remains in the existing web settings.

Credentials stay in device-only Keychain entries, isolated by HTTPS server origin. A device must pair separately; Handoff carries no credentials or message body. HTTP, redirects, cookie storage and URL caching are disabled in application networking. Mail content stays in memory except explicitly exported attachments or drafts saved to the server. The optional HTML renderer blocks scripts, remote resources, navigation and form submissions.

The native API is `POST /api/native/v1/{operation}` with the opaque signed bearer returned by pairing. It delegates ownership checks and provider operations to the existing unified mailbox routers. It does not implement a second IMAP client or copy mailbox passwords to Apple devices. See [API.md](API.md).

On macOS:

```sh
cd native/apple
bash scripts/validate-macos.sh
open ZeroMail.xcodeproj
```

This handoff was developed and checked on Linux. Foundation/Swift protocol tests, server integration tests, Swift syntax and project structure checks pass; **Xcode builds, SwiftUI runtime behavior, Keychain on Apple hardware and distribution have not yet been executed**. The macOS workflow is configured but was not run during this handoff. Push notifications, widgets, share extensions, offline storage, app icons, signing and distribution are listed as subsequent work in the migration guide.

The existing Electron Windows client and experimental Capacitor shell remain available. Apple development should continue in this directory.

Authentication and recovery: [deployment guide](../../deploy/AUTHENTICATION.zh-CN.md). Apple references: [SwiftUI navigation across platforms](https://developer.apple.com/documentation/technotes/tn3154-adopting-swiftui-navigation-split-view), [independent watchOS applications](https://developer.apple.com/documentation/watchos-apps/creating-independent-watchos-apps), [Handoff](https://developer.apple.com/documentation/foundation/implementing-handoff-in-your-app).
