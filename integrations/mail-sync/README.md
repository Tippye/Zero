# Local background mail synchronization

This Node service runs separately from the interactive Worker API. It indexes Gmail and IMAP mail in the local PostgreSQL database even when every browser is closed. It never sends or deletes mail at the provider.

The service discovers OAuth accounts in the existing connection table and IMAP account metadata through the authenticated local bridge. Google tokens remain in the worker; IMAP credentials remain inside the bridge vault. Logs contain provider/status codes, never mail content or credentials.

Defaults per mailbox: 500 recent entries, 90 days, 50 MB of on-demand body cache, sync every 120 seconds. Limits are configurable under Settings → General → Sync and local cache. Indexes cover inbox, sent, drafts, archive, spam, trash and stars. Lists, filtering and search use only the cached range. Bodies are fetched on first open and cached up to 5 MB per entry; attachments are not prefetched. Outbound sends and edits still contact the provider.

Gmail performs a bounded initial metadata sync, then uses history IDs for incremental changes. Expired history triggers a fresh bounded sync. A daily reconciliation enforces the retained window. Draft IDs are kept separately from message/thread IDs. IMAP uses one dedicated read-only connection per snapshot and fetches bounded envelope windows, without SEARCH ALL. Different accounts sync concurrently (maximum two jobs), and interactive IMAP operations use their own connection.

`schema.sql` creates the cache tables. Run `npm ci --ignore-scripts` in this directory. Start with `node src/worker.mjs` and these server-side variables:

- `DATABASE_URL`: local PostgreSQL connection string.
- `IMAP_BRIDGE_URL`, `IMAP_BRIDGE_SECRET`: existing bridge configuration.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: existing OAuth client.
- `ZERO_GOOGLE_PROXY`: optional proxy URL for Google HTTPS requests.

Set `MAIL_SYNC_ENABLED=true` in the API environment to serve folder lists from the local index. Without this flag, existing live-provider reads remain available. The existing snoozed-folder implementation is retained separately. Do not expose the database or service credentials to the browser.

The local deployment installs `.local/zero-mail-sync.service` as a user systemd service. `.local/manage.sh` manages it with the other services. A database advisory lock prevents duplicate workers. Jobs survive process restarts through database state; failures retain previously synced entries and retry later (five-minute delay for quota errors). A heartbeat lets the UI distinguish a stopped worker from a healthy empty mailbox. Cache eviction never issues a provider delete command.

Validation: `npm test` covers adapters. `.local/check-sync-cache.cjs` exercises real cache SQL in a temporary database schema. The IMAP bridge suite covers bounded read-only snapshot behavior and ownership.

Gmail sync reference: https://developers.google.com/workspace/gmail/api/guides/sync

## AI inbox categories

The independent worker also classifies cached inbox metadata into `primary`, `transactions`,
`updates`, and `promotions`. “All” is an unfiltered view and includes pending or failed items.
The classifier uses the owner's active encrypted LLM settings profile (small model if set,
otherwise main model), or the explicitly active environment profile. It respects provider
deactivation. Environment URL precedence is `OPENAI_BASE_URL`, `OPENAI_URL`, then `OPEN_URL`.

Each request contains at most 10 sender addresses and subjects; no body or attachment is sent.
This keeps requests small, although classification based on metadata can be imperfect.
Results are local cache columns, not Gmail labels or IMAP flags. Provider synchronization and
read/important flags preserve classifications; changed metadata is reclassified. Old results
are discarded if content or the active model changes during a request. Only one classification
request runs at a time, independently of mailbox synchronization; requests time out after
30 seconds, and failures back off for five minutes. The front end polls local status and refreshes
category results without a full page reload. Removing cached mail also removes its classification.

Run `npm test` for bounded response/metadata tests; the local `check-ai-classifier.cjs` harness
additionally tests real SQL in a disposable schema, owner isolation, profile encryption,
classification persistence and stale-result protection with mocked model responses.

### Manual categories and preference learning

The reading toolbar can move cached messages between Primary, Transactions, Updates, and Promotions. These local choices take precedence over AI classifications and survive cache eviction and mailbox refreshes. All Mail remains an aggregate view; custom label filters are not move destinations.

Settings → Categories has an opt-in learning switch (off by default). When enabled, classification uses up to 50 recent manual choices from the same user and mailbox, sharing only sender, subject, and chosen category with the configured model. Repeated corrections to one message replace its previous example. Disabling learning removes history from subsequent requests and discards in-flight results using outdated preferences; existing manual choices remain intact. This is classification context, not model fine-tuning.

Restart the mail-sync worker after updating: its idempotent startup schema creates `mail0_category_feedback`. Deploy the updated server and frontend with the worker schema in place.

Validation (from the repository root, with a local test database configured):

```sh
node integrations/mail-sync/test/classify.test.mjs
pnpm exec dotenv -e .env -- node integrations/mail-sync/test/category-storage.cjs
```

The storage check creates and drops an isolated temporary schema and uses synthetic messages and mocked model responses.

### Translated email panels

Translations replace only text nodes and human-readable `alt`/`title` attributes in the original HTML. Email tables, styles, images and link destinations remain unchanged. The reader shows the translated message in a panel with one translation icon at the top; the icon switches between the original and cached translation without another model call.

`mail0_mail_translations` stores translations per user, mailbox, thread, message, language and source hash. Retention is measured from translation completion using the current **local cache → maximum age (days)** setting, defaulting to 90 days. Reading or switching a cached translation does not extend its lifetime. Shortening the setting immediately removes expired entries. The reader hides the icon at expiry, and cache reads plus the worker's discovery cycle physically delete expired entries. Changing the source invalidates its previous translation.

Update/restart the mail-sync worker before the backend and frontend so the idempotent startup schema creates the translation table and indexes.

Regression checks from the repository root:

```sh
node --import tsx apps/server/src/lib/mail-translation.test.ts
pnpm exec dotenv -e .env -- node integrations/mail-sync/test/translation-storage.cjs
node scripts/test-mail-translation-ui.cjs
```

The database test uses an isolated temporary schema. The UI test uses mocked transport and blocks network requests; set `PLAYWRIGHT_EXECUTABLE_PATH` if Chromium is installed outside Playwright's default location. No regression check calls a real model.
