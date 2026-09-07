# Mobile pairing authentication

The Android client loads the configured Zero server's `/login` page. Updating the server switches existing Android clients to pairing codes and QR authorization; Android does not submit or store a Zero username/password. After approval, the WebView receives its own HttpOnly session cookie. The same cookie authenticates the existing background notification check. Revoking the device makes subsequent requests unauthorized.

Use **Settings → Security** inside the mail page to approve another device or revoke a session. QR links scanned with the system camera normally open the system browser, whose session is separate from the app. If that browser is not paired, enter the code in the already signed-in app instead. No camera permission is required for the manual code flow.

Switching servers or clearing app data still clears local sessions. Existing `mailto:`/compose redirects resume after pairing. New deployment configuration no longer contains a Zero login password; mailbox-provider credentials are configured separately after pairing.

The experimental iOS scaffold can reuse the shared web pairing page when integrated with the server. For native iOS/iPadOS and watchOS authentication, use the [Swift package and login view](../apple/README.md), which share the same API and keep native credentials in Keychain. Creating and validating full Apple application targets is separate from this authentication change.

See [pairing, first-device authorization and recovery](../../deploy/AUTHENTICATION.zh-CN.md).
