# Native mail API v1

All operations use `POST /api/native/v1/{operation}`, JSON bodies and `Authorization: Bearer <opaque pairing token>`. A cookie alone is rejected. Credentials and search expressions are never placed in the URL. Responses are ordinary JSON, without the tRPC/SuperJSON envelope. The API does not alter the web client's tRPC contract.

| Operation      | Input                                                   | Result                                                                 |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `accounts`     | `{}`                                                    | `{accounts: [...]}`                                                    |
| `threads`      | `accountId?`, `folder?`, `q?`, `cursor?`, `maxResults?` | `{threads, cursor, warnings}`                                          |
| `thread`       | `id`                                                    | `{id, unread, starred, messages}`                                      |
| `attachments`  | `id` (message ID)                                       | `{attachments: [{attachmentId, filename, mimeType, size, body, ...}]}` |
| `action`       | `ids`, `action`                                         | `{success: true}`                                                      |
| `save-draft`   | outgoing mail                                           | `{id}`                                                                 |
| `draft`        | `id`                                                    | `{id, to, cc, bcc, subject, content, text, attachments}`               |
| `delete-draft` | `id`                                                    | `{success: true}`                                                      |
| `send`         | outgoing mail                                           | existing unified send response; inspect `success`                      |
| `sync`         | `accountId?`                                            | existing sync request acknowledgement                                  |

Folders: `inbox`, `starred`, `sent`, `draft`, `archive`, `spam`, `trash`. `trash` maps to the existing cache's `bin` folder. Actions: `read`, `unread`, `star`, `unstar`, `archive`, `trash`. There is no permanent deletion operation.

Preserve every returned ID and cursor exactly. IDs include mailbox ownership. A cursor is valid only for its original account, folder and search. Pages contain at most 30 entries; the apps request 20. Warnings represent partial mailbox failures and must remain visible.

Outgoing mail has `accountId`, `to` / `cc` / `bcc` arrays of `{email, name?}`, `subject`, HTML `message`, `attachments`, UUID `operationId`, optional `draftId` / `threadId`, and optional `headers` (`In-Reply-To`, `References`). Each attachment has `name`, `type`, `size`, `lastModified` (milliseconds) and standard `base64`. At most 20 files / 15 MiB total; request body limit is 24 MiB. Attachment data must match its declared size.

Thread reads carry attachment metadata only. Downloaded `body` supports standard or URL-safe Base64. Draft reads return attachment payloads; Gmail draft IDs are resolved to message IDs under the same owned mailbox. Unedited draft HTML is retained by the Swift composer; editing the body produces escaped plain text inside HTML. Replies omit Bcc recipients.

Sending uses a 120-second client timeout and is never retried automatically. An SMTP timeout may mean the message was delivered. The IMAP bridge supports the stable operation ID; do not assume OAuth providers supply the same idempotency guarantee. The UI disables another send after an uncertain response and tells the user to inspect Sent.

Errors have `{error: code}`: `401` invalid/revoked session, `400` invalid input, `403` forbidden, `404` missing operation/mailbox, `409` provider precondition, `429` rate limit, `413` oversized body, `502` upstream failure. A `401` clears that origin's local credential. Network and mailbox errors preserve pairing. The existing unified routers retain owner validation, provider limits and synchronization behavior.

The apps currently keep messages in memory and refresh on foreground activation or user request. `sync` schedules server work; it does not promise the new mail is available immediately. Background push, offline queues and provider administration are outside v1's native UI.
