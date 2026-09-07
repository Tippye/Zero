# ZeroPairing — Apple authentication

Shared Swift package for macOS 12+, iOS/iPadOS 15+, and watchOS 8+. It implements the same password-free device authorization used by the web, Electron and Android clients. It has no third-party dependencies.

Add this local package to an Apple app target and present:

```swift
import ZeroPairing

let authentication = try PairingClient(server: URL(string: "https://mail.example.com")!)
PairingLoginView(client: authentication, deviceName: "My iPhone") {
    // Replace the login screen with the app's authenticated content.
}
```

The view displays the short code and, where Core Image is available, a QR code. A signed-in device or the server administrator must approve it. The request's private secret stays in memory. Successful authorization stores a separate, opaque bearer value in Keychain for this exact server origin; the token is not shared with another Apple device. Failed or expired requests can be started again. Cancelling the view stops polling.

`preview(code:)` and `decide(code:requestID:approve:)` support native approval screens. Display the preview and obtain explicit user confirmation before calling `decide`. `devices()`, `revoke(_:)` and `signOut()` manage device sessions. A network failure during sign-out clears the local credential and reports the failure; use another device or the server CLI to revoke the remote session if necessary.

The default transport uses an ephemeral URLSession, ignores cookies, refuses redirects, and verifies TLS normally. HTTP is disabled unless the caller explicitly passes `allowHTTP: true` for a trusted local deployment. Keychain items use `AfterFirstUnlockThisDeviceOnly` and do not sync through iCloud. Linux has no plaintext credential fallback; tests inject an in-memory store.

```sh
cd native/apple
swift test
```

The `Apple authentication module` GitHub workflow tests Keychain and builds iOS/iPadOS and watchOS simulator libraries on macOS. Linux tests exercise the protocol and store interface; they do not compile SwiftUI or Security.framework. The repository's iOS Capacitor shell is still experimental, and complete macOS/iOS/watchOS mail app targets remain separate platform-adaptation work. This package supplies their authentication flow and view, not a distributable mail application.

See [the complete pairing and recovery guide](../../deploy/AUTHENTICATION.zh-CN.md). Apple API references: [ephemeral URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/ephemeral), [Keychain device-only access](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly).
