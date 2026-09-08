# Conversations and offline reading

## Objective and acceptance criteria

Papernook has two libraries, Papers and Conversations, with independent topics,
tags, searches and counts. Import ChatGPT and Claude public share links or an
exported transcript, study the imported document with Papernook's configured AI,
and download either kind of document with its existing follow-up chats to a phone.
The installed app opens its offline library when the server cannot be reached.
Settings lists downloads, sizes and synchronization dates and supports individual
removal and clearing all device downloads without deleting server documents.

Acceptance checks:

1. Existing papers still open, annotate, chat, capture and export as before.
2. A conversation can be imported, categorized, searched and opened without
   appearing in Papers, the paper graph, citations, shared WebDAV or another
   profile's library. Identical topic names in the two libraries remain separate.
3. The original transcript remains a source snapshot. Follow-up chats are separate
   and use that source as context through the existing provider registry.
4. A selected paper downloads its PDF, summary, text, current profile's chats and
   required images. A conversation downloads its transcript and follow-up chats.
5. After closing and reopening the browser with networking disabled, both document
   kinds and their existing chats remain readable, including code, tables and math.
6. An unavailable server triggers the offline reader even if navigator.onLine is
   true. Authentication failures never silently unlock cached server responses.
7. Reconnection returns to the corresponding online document with reading position
   retained where possible. Local downloads refresh while the app is open online.
8. Download failures, storage denial, quota exhaustion and partial asset failures
   produce actionable errors and do not replace an earlier complete download.
9. Offline AI sends and server mutations are unavailable. Offline annotation editing
   and background mutation synchronization are outside this delivery.
10. Settings works offline, shows actual stored payload sizes, can remove individual
    items or all downloads, and cannot mutate server files.
11. Profile switching and logout cannot expose another profile's cached documents.
12. Existing paper PDFs and self-contained HTML study exports can be saved outside
    browser storage. Conversation PDF export uses the browser print dialog's Save
    as PDF, retaining Unicode, tables and rendered math without a server browser.

## Verified starting points

- `src/lib/library/papers.ts`: shared filesystem paper model and companion paths.
- `src/lib/library/chats.ts`: per-paper, per-profile JSONL chat storage.
- `src/lib/library/chat-context.ts`: paper context and provider prompt preparation.
- `src/lib/agent/registry.ts`: canonical provider selection and capabilities.
- `src/lib/capture/download.ts`: DNS-pinned public fetching and redirect protection.
- `src/lib/capture/bounded-response.ts`: response size enforcement.
- `src/components/library/LibraryView.tsx`: paper topics, tags, search and cards.
- `src/components/chat/ReadingWorkspace.tsx`: responsive reader/chat layout.
- `src/components/chat/Markdown.tsx`: existing safe GFM, code and KaTeX rendering.
- `src/components/chat/ChatPanel.tsx`: existing paper chat UI and API contract.
- `src/app/paper/[topic]/[slug]/page.tsx`: PDF reader and chat integration.
- `src/components/pwa/PwaSetup.tsx`: sidedoor service worker registration.
- `public/sw.js`: currently caches static assets only, deletes other caches on
  activation, and is overwritten by package.json postinstall.
- `src/proxy.ts`: profile gate, CSP nonce and public route allowlist.
- `src/app/settings/page.tsx`: settings integration point.
- `src/components/profiles/AccountBar.tsx`: logout and switch-profile actions.
- `playwright.config.ts`: service workers are blocked by default in existing tests.

## Architecture

### Private conversations

Create a filesystem store under `data/users/<username>/conversations/<id>/`.
Each record contains versioned metadata, a structured source transcript and separate
follow-up chat JSONL files. Source metadata includes provider, original URL when
available, title, import timestamp, topic and tags. Validate usernames, identifiers,
lengths, role ordering and total payload sizes. Do not use shared paper paths for
private conversation PDFs. Do not force conversation records into SQLite's paper
index; a bounded profile-local scan is sufficient for the initial library.

Reuse the existing Markdown and ReadingWorkspace components and provider registry.
Extract reusable chat storage/context behavior only where needed; do not duplicate
provider invocation logic in UI code. A conversation source is quoted untrusted
context, never system instructions supplied by the imported author.

Public share adapters accept only canonical HTTPS ChatGPT/Claude share URLs.
Use fetchPublicUrl for network access, bounded responses and pinned redirect checks.
Decode actual provider payloads and preserve the visible message branch, not every
alternative assistant answer. Reject login pages, bot challenges and empty results.
If browser extraction is needed, isolate it and block private network/subresource
access. Do not send user credentials to a third-party extraction service. Offer
explicit file/paste import when a provider refuses automated extraction; never
silently turn an error page or partial scrape into a successful document.

Export import supports structured JSON and Markdown/text. Codex session exports
use an explicit file adapter with user/assistant messages; do not mount CLI history
into the production container. Attachments absent from a share are disclosed, not
fabricated. Rendered exports must not execute imported HTML or scripts.

### Offline snapshots

Use a versioned, typed snapshot contract shared by server packaging and browser
storage. A snapshot has owner, document identity/type, title/topic/tags, canonical
online URL, downloadedAt, source revision, text/summary, transcript/chat history
and local assets. Paper snapshots contain the current PDF bytes. Never package
another profile's chats or unrestricted companion directories.

IndexedDB stores complete snapshots as atomic records with Blob payloads, or a
transactional manifest plus blobs. Compute bytes from stored payloads. Downloads
validate response status/content type and required assets before transaction commit.
Replace a complete version atomically; cancelled or failed refreshes keep the old
version. Serialize refresh/clear operations so an in-flight download cannot
resurrect an item after it has been removed. Bound per-item bytes and concurrency.

A dedicated offline shell has no server-rendered private data and can boot without
server authentication. It renders only the selected device profile's downloads.
Never cache authenticated Next.js HTML, RSC responses, arbitrary API responses or
mutation results. Cache only owned static assets and the generic offline shell.
The service worker owns only Papernook cache names and preserves IndexedDB data
across shell updates. Remove postinstall's overwrite of public/sw.js.

The offline shell is a separately bundled static entry: `src/lib/offline/app.ts`
and `src/lib/offline/storage.ts`, built by `scripts/build-offline.mjs` using esbuild
into `public/offline/`. The build also vendors PDF.js, its worker and required
font/CMap/WASM assets and generates a precache manifest. Its explicit static CSP
permits only same-origin scripts and local Blob/data assets. The nonce-bearing
Next.js proxy does not handle these generic static assets. Server-rendered safe
study HTML embeds its math styles/fonts. No private snapshot is in the shell.

The offline renderer needs local PDF.js assets/worker and math styling/fonts, or
equivalently pre-rendered safe self-contained HTML plus local PDF rendering. Avoid
depending on a phone's iframe PDF support. Unknown/unavailable documents show a
clear not-downloaded state with navigation to downloads. Read-only controls replace
AI send, annotation save and other server mutations in the offline reader.

### Connectivity and identity

Use an explicit health/session probe with timeout plus online/offline events.
Network failure/timeouts/server unavailability activate offline routing; 401/403
retain authentication behavior and do not serve cached protected API responses.
Keep a validated same-origin return route, document identity and local position.
Restore that route when the server is reachable and the session is still valid.
Do not oscillate routes on transient failures or redirect an unsaved online chat.

Bind downloaded data to the authenticated username and reconcile identity on every
online app boot. On logout and profile switching, clear the active offline identity
and purge private downloads according to the UI's stated policy, including across
tabs. Never trust a profile name supplied to a server snapshot endpoint.
The successful login/session-change boundary and direct login-page visits also
invalidate device identity. Validate `profile` in the session JSON: a 200 response
with `profile: null` is signed out. A transactional identity generation prevents
in-flight downloads from committing after clear/switch/logout. Broadcast invalidation
clears rendered content and Blob URLs across tabs.

Required images mean approved local attachments referenced by included messages.
Do not fetch arbitrary Markdown image URLs: the current renderer intentionally
renders those as links. Missing attachments get a visible unavailable label.
Share import has body limits, an overall deadline, bounded concurrency, final-origin
validation and guaranteed public-fetch dispatcher cleanup.

The handoff URL `/conversations?import=<encoded-share-url>` prefills an import form.
GET never creates a document. The user submits the import, then receives a private
`/conversations/<id>` URL with View original linking to the preserved source URL.
The supplied ChatGPT sample loaded in headless Chromium on 2026-09-08 with title
Interview expectations at HERE and structured React Router conversation data.

### Offline storage UI

Add Available offline/Update download controls to papers and conversations and a
Downloads link in library navigation. Settings → Offline storage lists type, title,
topic, size and last update, with refresh, remove and clear-all controls. Explain
that browser-managed downloads are local to this device; Export to Files creates
independent files. Request persistent storage when saving and report unsupported
storage or quota errors. Browser eviction remains possible and must not be
represented as permanent guaranteed storage.

## Execution phases and files

### Phase 1: Conversation library and import/export

Add `src/lib/conversations/` for schema, private store, adapters and rendering;
`src/app/api/v1/conversations/` for profile-authenticated CRUD/import/export/chat;
`src/app/conversations/` and `src/components/conversations/` for library and reader.
Add shared library navigation and integrate it into LibraryView. Adapt ChatPanel
with an optional API base only if its existing behavior can be retained. Update
the corresponding behavior tests and new conversation import/privacy tests.

Required tests: source order and branching, malformed/oversized input, supported
share URL validation, private URL refusal, challenge-page errors, Unicode/code/math
preservation, independent categories, filesystem reload, owner isolation, delete,
AI transcript grounding and streamed error handling, safe HTML exports.

### Phase 2: Snapshot packaging and offline storage

Add `src/lib/offline/` typed contracts, browser storage and download orchestration;
`src/app/api/v1/offline/` owner-authenticated packaging; and
`src/components/offline/` download buttons, storage management and reader UI.
Use existing paper/chats/conversation functions to assemble snapshots. Integrate
download buttons into paper and conversation readers and management into Settings.

Required tests: only active profile chats included, complete source PDF included,
asset bounds, missing asset errors, atomic refresh and delete/refresh races,
accurate byte counts, storage errors, no server deletion from local removal.

### Phase 3: Offline boot and automatic routing

Own `public/sw.js`; add generic offline shell and its static assets. Update
PwaSetup, proxy/public paths and package postinstall as needed. Integrate local
identity cleanup with profile navigation/logout and a connectivity coordinator.
Use explicit downloads, not opportunistic caching of private HTTP traffic.

Required tests: service worker install/update, network-first normal navigation,
offline cold boot from home and document URLs, all downloaded asset dependencies,
server-down while navigator.onLine is true, authentication failures, restoration
of document and position on reconnect, no mutation submission offline, profile
switch/logout across tabs, cache cleanup limited to owned namespaces.

### Phase 4: Integration, review and documentation

Run the full `npm run ci` gate and affected Playwright tests, with new offline
tests explicitly enabling service workers. Exercise mobile Chromium and WebKit
where the installed engine supports service workers. Verify no horizontal overflow,
download progress/error states, keyboard labels and a usable phone reader.
Document download scope, refresh policy, browser storage limitations, deployment
requirements and supported imports in user docs. Run a fresh scoped final review,
fix substantive findings, and record exact validation results here.

Each phase must pass CI before its commit. Review `git diff --cached` before every
commit and preserve the repository's commit style. No deployment or merge is part
of this request. Keep the worktree and completed plan available for review.

## Risks and delivery boundaries

- Shared-link extraction depends on providers' undocumented page formats. Fixtures
  establish parser behavior; real provider access must be reported separately.
- Imported source and chats are private. Reusing shared WebDAV paths would leak
  them and is prohibited.
- The current sidedoor worker deletes all foreign caches. Its replacement and
  postinstall behavior must be verified together.
- Next.js nonce-bearing authenticated pages are unsuitable as cached app shells.
- PDF range requests, PDF.js worker chunks and KaTeX fonts must work offline.
- Large PDFs and image-heavy chats can exceed phone quotas. Fail atomically and
  keep the last complete download. No promise that browsers never evict downloads.
- Existing paper annotation, citations, graph and capture must remain unchanged.
- No offline AI inference, queued annotation writes, live source-link synchronization,
  EPUB, external deployment or automatic server-file deletion in this delivery.

## Execution record

- Worktree: `../papernook-wt-offline-conversations`, branch `wt/offline-conversations`.
- Base: `a9506f6` on `main`; main checkout was clean.
- Plan based on the actual local source and installed Next.js PWA documentation.
- Fresh Codex pre-implementation review completed. Its seven findings are reflected
  above: login boundary, null-profile responses, static shell/CSP, chat identity,
  attachment selection, print-based PDF export and bounded importer cleanup.
- Claude review was attempted but organization subscription access was disabled.
- Implementation completed; final verification is recorded below.

### Completed implementation

- Private conversation store, source adapters, independent library and grounded
  follow-up chats implemented. Revoking a provider share does not affect reads.
- Safe HTML, Markdown and JSON exports implemented. Conversation PDF uses the
  browser's print-to-PDF action. Local PDF.js provides phone PDF reading offline.
- Profile-bound IndexedDB downloads, storage controls, versioned offline shell,
  automatic routing and identity invalidation implemented.
- The real supplied ChatGPT URL loaded through the server-side adapter. After
  excluding tool requests and hidden reasoning/status records, its saved payload
  contains eight visible messages and 87,716 characters. Source contents were not
  added to fixtures. Claude's share adapter is fixture-tested; no live Claude share
  was supplied for verification.
- Downloads store PDF bytes as ArrayBuffers and reconstruct Blobs when reading.
  This avoids IndexedDB Blob transaction failures observed in mobile WebKit.
- Fresh final review covered identity races, source privacy, rendering and export.
  Direct login-page visits now revoke offline identity before asynchronous cleanup,
  including when IndexedDB is unavailable.
- Implementation was integrated as one working change before committing because
  the conversation reader's download control and snapshot contract cross phases.
  No partial phase has been committed or deployed.

### Verification

- `npm run ci`: passed lint, formatting, TypeScript, unit/API tests, production
  build and runtime-artifact privacy checks. The runtime includes KaTeX fonts and
  CSS needed for exports. Full output: `/tmp/papernook-offline-ci-final.log`.
- Unit/API suite: 85 files passed, 712 tests passed and one existing test skipped.
- `npm run test:e2e -- --update-snapshots`: all 34 tests passed, including the
  existing paper reader, annotations, sharing, settings and WebKit reader checks.
  Updated and visually reviewed the two paper screenshots affected by the download
  control. Kept the unrelated invitation screenshot unchanged.
- `npx playwright test --config=playwright.offline.config.ts`: 15 passed, three
  skipped. Android Chromium covers browser restart, offline PDF and chat reading,
  reconnect, separate categories, clear/remove races, unavailable storage, drafts
  and profile changes. WebKit covers server failure with a saved PDF, drafts,
  authentication, unavailable storage and cross-tab invalidation.
- WebKit's offline network emulation fails cached-page navigation with an internal
  engine error. A minimal service worker returning a cached heading reproduces it
  on reload and new-tab navigation; Chromium succeeds with the same fixture.
  Two WebKit cold-navigation tests are explicitly skipped, as is the test requiring
  Chromium's persistent-browser launcher. Physical iPhone cold start is unverified.
- Mobile results: `/tmp/papernook-offline-mobile-verified-2.log`; independent engine
  reproduction: `/tmp/papernook-webkit-minimal.log`.
- Behavioral test review found only system-boundary mocks. Export coverage verifies
  that revoking the original source does not prevent private reads or exports.
