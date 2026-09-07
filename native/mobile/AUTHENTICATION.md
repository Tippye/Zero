# Mobile pairing authentication

The Android client loads the configured Zero server's `/login` page. Updating the server switches existing Android clients to pairing codes and QR authorization; Android does not submit or store a Zero username/password. After approval, the WebView receives its own HttpOnly session cookie. The same cookie authenticates the existing background notification check. Revoking the device makes subsequent requests unauthorized.

Use **Settings → Security** inside the mail page to approve another device or revoke a session. QR links scanned with the system camera normally open the system browser, whose session is separate from the app. If that browser is not paired, enter the code in the already signed-in app instead. No camera permission is required for the manual code flow.

Switching servers or clearing app data still clears local sessions. Existing `mailto:`/compose redirects resume after pairing. New deployment configuration no longer contains a Zero login password; mailbox-provider credentials are configured separately after pairing.

The experimental iOS scaffold can reuse the shared web pairing page when integrated with the server. Apple development now continues in the [native SwiftUI applications](../apple/README.md): `ZeroMail.xcodeproj` includes macOS, iPhone/iPad and independent watchOS targets, using the shared pairing API and device-only Keychain credentials. See the [macOS migration guide](../apple/MIGRATION.zh-CN.md) for Xcode validation and remaining platform work.

See [pairing, first-device authorization and recovery](../../deploy/AUTHENTICATION.zh-CN.md).
