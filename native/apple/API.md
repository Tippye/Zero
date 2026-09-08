# Native mail API v1

All operations use `POST /api/native/v1/{operation}`, JSON bodies and `Authorization: Bearer <opaque pairing token>`. A cookie alone is rejected. Credentials and search expressions are never placed in the URL. Responses are ordinary JSON, without the tRPC/SuperJSON envelope. The API does not alter the web client's tRPC contract.

Apple AI compatibility: if `ai-status` returns `NOT_FOUND`, a client can verify the existing authenticated web API with `GET /api/trpc/llm.list`. After successful capability detection, AI uses only `ai.read` (POST), `ai.translation` (GET) and `imap.generate` (POST, compose task), with SuperJSON `{json: input}` and `result.data.json`. Query input is URL-encoded; bearer remains in the header and generation content remains in POST bodies. A submitted generation is never retried on another route. Provider URLs and keys stay server-side. See [compatibility details](AI-COMPATIBILITY.zh-CN.md).

| Operation      | Input                                                   | Result                                                                 |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `accounts`     | `{}`                                                    | `{accounts: [...]}`                                                    |
| `threads`      | `accountId?`, `folder?`, `category?`, `q?`, `cursor?`, `maxResults?` | `{threads, cursor, warnings}`                                  |
| `thread`       | `id`                                                    | `{id, accountId, unread, starred, messages}`                            |
| `attachments`  | `id` (message ID)                                       | `{attachments: [{attachmentId, filename, mimeType, size, body, ...}]}` |
| `action`       | `ids`, `action`                                         | `{success: true}`                                                      |
| `save-draft`   | outgoing mail                                           | `{id}`                                                                 |
| `draft`        | `id`                                                    | `{id, to, cc, bcc, subject, content, text, attachments}`               |
| `delete-draft` | `id`                                                    | `{success: true}`                                                      |
| `send`         | outgoing mail                                           | existing unified send response; inspect `success`                      |
| `sync`         | `accountId?`                                            | existing sync request acknowledgement                                  |
| `events`       | `after?` (decimal string)                                | `{owner, cursor, events: [{id, threadId, accountId, sender, subject}]}`   |
| `classification-status` | `{}`                                          | Shared synchronization/classification progress for the paired owner      |
| `classification-settings` | `{}`                                        | `{enabled, defaults, settings}` with the owner's resource limits         |
| `classification-save` | six bounded integer resource settings              | `{success, settings}`                                                     |
| `classification-control` | `action: start | pause | restart`                 | `{success: true}`                                                         |
| `mail-category` | owned `id`                                               | `{enabled, category}`                                                     |
| `move-category` | owned `id`, concrete `category`                          | `{success: true}`                                                         |
| `ai-status`    | `{}`                                                    | `{ready, name, model}` for the owner's active BYOK profile               |
| `ai-read`      | `threadId`, `messageId`, `action`, `language`, `question?`, `history?` | `{text, translation}` using the shared web reader                 |
| `ai-translation` | `threadId`, `messageId`                              | `{translation}` from the shared server cache, or `null`                 |
| `ai-compose`   | `instructions`, `consent: true`                         | `{text, model}` for explicit review and application to the draft        |

Folders: `inbox`, `starred`, `sent`, `draft`, `archive`, `spam`, `trash`. `trash` maps to the existing cache's `bin` folder. Inbox categories are `primary`, `transactions`, `updates`, `promotions`; omitting `category` returns all mail. Categories require server-side local synchronization. Actions: `read`, `unread`, `star`, `unstar`, `archive`, `trash`. There is no permanent deletion operation.

Classification settings use the same owner-scoped records as the web UI: `concurrency` (1–4), `batch_size` (1–50), `interval_seconds` (2–3600), `timeout_seconds` (5–120), `recent_days` (1–365) and `history_every_batches` (1–100). Native input is strict and cannot include an owner ID. The classifier reads persisted limits when admitting a new batch; running work finishes normally. AI fetch concurrency, response size and timeout enforcement remain on the server, so no provider credential or isolation primitive is copied to an Apple device.

Preserve every returned ID and cursor exactly. IDs include mailbox ownership. A cursor is valid only for its original account, folder and search. Pages contain at most 30 entries; the apps request 20. Warnings represent partial mailbox failures and must remain visible.

Notification `events` uses the same durable SQL event feed as Windows/web `GET /api/desktop/events`. Omit `after` to establish a quiet baseline; then pass the returned decimal string unchanged, scoped to the server and owner. Each page contains at most 25 events, including events beyond the current mailbox list. Only recent events whose messages remain unread in Inbox are returned. Historical imports, other owners, read/archived/deleted messages and events older than one day are excluded. An unsupported deployment or older native API returns `404` / `NOT_FOUND`; clients preserve mailbox access while reporting notification unavailability. This is polling while the app can run, not APNs background push.

Outgoing mail has `accountId`, `to` / `cc` / `bcc` arrays of `{email, name?}`, `subject`, HTML `message`, `attachments`, UUID `operationId`, optional `draftId` / `threadId`, and optional `headers` (`In-Reply-To`, `References`). Each attachment has `name`, `type`, `size`, `lastModified` (milliseconds) and standard `base64`. At most 20 files / 15 MiB total; request body limit is 24 MiB. Attachment data must match its declared size.

Thread reads carry attachment metadata only. Downloaded `body` supports standard or URL-safe Base64. Draft reads return attachment payloads; Gmail draft IDs are resolved to message IDs under the same owned mailbox. Unedited draft HTML is retained by the Swift composer; editing the body produces escaped plain text inside HTML. Replies omit Bcc recipients.

Thread `accountId` identifies the owning mailbox after the unified reader's authorization check, so replies from Handoff and direct links use the correct sender even outside the current list. Native clients also accept older responses without this field, deriving ownership from the scoped `mbx` thread ID before considering list metadata or unambiguous legacy address matches.

Sending uses a 120-second client timeout and is never retried automatically. An SMTP timeout may mean the message was delivered. The IMAP bridge supports the stable operation ID; do not assume OAuth providers supply the same idempotency guarantee. The UI disables another send after an uncertain response and tells the user to inspect Sent.

AI reading supports `summary`, `translate` and `ask`. It uses the web reader's ownership checks, owner-selected BYOK model, prompt rules and translation cache. Only thread/message identifiers and the user's question/history are submitted by the app; the server resolves the owned mail. IDs are at most 16,000 characters, language is 2–50 characters, questions are at most 2,000 characters, and history contains at most six question/answer pairs. A translation has `subject`, `html`, plain `text`, `language` and `expiresAt` (Unix milliseconds); native HTML previews use the same isolated renderer as original mail.

Opening the AI panel only reads availability and an existing translation. Model generation requires a user action. The native API never returns provider keys, encrypted keys or provider URLs. Composition requires explicit `consent: true` and 1–8,000 trimmed instruction characters, returns text for review and never sends mail. The optional current draft body is included only when the user selects it. AI generation uses a 150-second client timeout and supports cancellation without client retries; server-side provider behavior remains shared with web. BYOK configuration remains in the authenticated web settings.

Errors have `{error: code}`: `401` invalid/revoked session, `400` invalid input, `403` forbidden, `404` missing operation/mailbox, `409` provider precondition or send operation conflict, `429` rate limit, `413` oversized body, `502` upstream failure. A `401` clears that origin's local credential. Network and mailbox errors preserve pairing. The existing unified routers retain owner validation, provider limits and synchronization behavior.

The apps currently keep messages in memory and refresh on foreground activation or user request. `sync` schedules server work; it does not promise the new mail is available immediately. Background push, offline queues and provider administration are outside v1's native UI.
