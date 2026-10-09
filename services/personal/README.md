# Herald Personal service

One authenticated API owns commitments, check-ins, daily plans and agent projections for both
Herald Desktop and Hermes. It can read the existing Ingelmec Mail workspace, which retains its
database, classification and native interface. Without a configured workspace, the basic Graph/Gmail
adapter maintains a local mail snapshot. A fresh database has no demonstration records. Mail bodies
and coding outcomes are data; this service never executes them. No sending or deletion endpoint exists.

## Run locally

Create the service environment through the repository setup, install `requirements.lock`, and run
from this directory:

```sh
.venv/bin/python -m herald_personal --host 127.0.0.1 --port 8787
```

The default state directory is `~/.local/share/herald-personal`. Set an explicit
`HERALD_PERSONAL_DATA_DIR` for a test instance. The SQLite database and newly created directory use
private permissions. Schema migrations run before the application serves requests; currently v3.
Use **one service process/worker per data directory**. SQLite serializes record changes, and one
provider operation runs at a time inside that process. Run multiple personal instances with
separate data directories and tokens.

`GET /healthz` returns only `{"status":"ok"}`. Every `/v1` request requires a bearer token. Missing
or unreadable configuration returns 503; invalid authorization returns 401. The service binds to
loopback by default. A remote deployment needs an operator-configured HTTPS proxy and process
supervisor; this command does not provision them.

## Operator configuration

| Variable | Purpose |
| --- | --- |
| `HERALD_PERSONAL_TOKEN` | Bearer token shared by the trusted Electron/MCP clients |
| `HERALD_PERSONAL_TOKEN_FILE` | Alternative private token file, reread on every request |
| `HERALD_PERSONAL_DATA_DIR` | Instance state directory |
| `HERALD_MAIL_WORKSPACE_URL` | Existing mail application's operator-selected origin, e.g. `http://127.0.0.1:8097` |
| `HERALD_MAIL_WORKSPACE_TOKEN_FILE` | Optional private bearer credential for the native mail action API |
| `HERALD_MICROSOFT365_TOKEN` / `HERALD_MICROSOFT365_TOKEN_FILE` | Delegated Microsoft Graph access token |
| `HERALD_MICROSOFT365_MSAL_CACHE` | Optional **private copy** of a delegated MSAL cache |
| `HERALD_MICROSOFT365_CLIENT_ID` | Client ID belonging to that cache |
| `HERALD_MICROSOFT365_TENANT_ID` | Tenant ID, `organizations`, or `common` |
| `HERALD_GMAIL_TOKEN` / `HERALD_GMAIL_TOKEN_FILE` | Gmail OAuth access token |
| `HERALD_PERSONAL_MAIL_DRAFT_ENABLED` | Only the exact value `true` enables draft creation |
| `HERALD_PERSONAL_MAIL_ARCHIVE_ENABLED` | Only the exact value `true` enables archive and undo |

Token files must be regular files without group/other permissions, normally mode 600. A file may
contain a token or JSON with an `access_token` string. Symlinks, oversized files, embedded whitespace
and empty tokens fail closed. Raw token values are never returned through API responses or included
in record/audit data. Environment values take precedence over their corresponding file.

Microsoft MSAL mode takes precedence when all three MSAL variables are configured. Its status
check is local only. An explicit mail operation acquires/refreshes the delegated token silently
and persists the private cache atomically. Ambiguous accounts fail closed. The default requested
scope is `Mail.Read`; explicitly enabling a write capability requests `Mail.ReadWrite` and still
requires provider consent. Never point the personal instance at another application's live cache.
Gmail access tokens must be renewed by an operator-owned credential process and rotated in the
private token file. This service does not implement a Gmail OAuth consent flow.

For the basic adapter, configuration is not a connection test. A provider becomes `connected:true` only after successful
synchronization. `last_sync_at` is the last success, including after a process restart. A subsequent
failure preserves the old snapshot and cursor, sets `connected:false`, and exposes a sanitized,
actionable error. Requesting basic-adapter status does not contact either mail provider.

## Existing Ingelmec Mail workspace

Setting `HERALD_MAIL_WORKSPACE_URL` selects the original mail application as the single authority,
including when its URL or credential is invalid. No Graph/Gmail adapter is initialized in that mode.
Existing Herald mail snapshots remain on disk but do not feed summaries or accept new mail actions.
Removing the workspace setting is an explicit operator choice to return to the basic adapter.

The bridge accepts HTTP only for a loopback origin, or an explicitly configured HTTPS origin.
Credentials, paths, query strings and fragments are rejected in the origin. A configured token file
must be readable and private; an invalid token file never falls back to unauthenticated requests.
Requests have fixed timeouts, never follow redirects and do not inherit proxy environment variables.
The bridge sends its own bearer credential only to the configured origin. It never forwards the
caller's cookies, CSRF headers or frontend capability to the original application.

| Personal API | Behavior |
| --- | --- |
| `GET /v1/mail-workspace/status` | Returns `configured`, `reachable`, `base_url`, `error` and `counts`; reads only native `mail-counts`, using `periodo=ventana`. |
| `POST /v1/mail-workspace/query` | Takes `{action, params}` and invokes one allowed native GET action with strict, bounded parameters. Returns the native JSON object, capped at 1 MiB. |
| `POST /v1/mail-workspace/local` | Strict local-only classification/compose contracts for the native desktop; never proxies browser-only approvals or provider writes. |
| `POST /v1/mail-workspace/tasks` | Takes `{clave, title?, due_at?, priority?}`; rereads the exact `MAIL-n` item and creates/reuses a commitment with `source_id=ingelmec-mail:MAIL-n`. Copies its title and source link, not its message bodies. |

Read actions are `mail-counts`, `mail-list-items`, `mail-get-item`, `mail-draft-get`,
`mail-carpetas`, `mail-aprendizajes-listar`, `mail-limpieza-propuestas`, `mail-metricas`,
`mail-connection-status`, `mail-rezagados`, `mail-backfill-estado` and `mail-lotes-estado`.
The connection-status action can refresh the original application's OAuth cache and runs only
on an explicit query; passive status, overview and daily-plan collection never call it.
Counts follow the original application's configured window. Lists preserve native `limite` and
`desplazamiento`; the bridge allows at most 100 items per query. Reading a thread requests plain text,
bounded messages and bounded characters. Unknown actions or parameters return 422, upstream failures
return sanitized errors, and oversized responses fail rather than silently truncating mail.

`GET /v1/status` and `GET /v1/overview` expose `mail_source: "workspace" | "basic"` plus
`mail_workspace` (null in basic mode). In workspace mode, `providers` is empty, draft/archive
capabilities are false, and `counts.urgent_mail` comes from native `porPrioridad.alta`; unavailable or
missing aggregates are null. Morning/evening briefs describe native response queues and explicitly
say when the original workspace cannot be verified. Legacy mail list, sync, categorization, capture,
draft, archive and undo routes return 409 in this mode, including generic task captures from old
mail IDs. Manual commitments and previously created commitments remain usable.

JEV classification, GLM's second criterion, drafting and learning logic remain in the original
service. Herald renders their results natively and exposes local drafting on explicit requests.
The read bridge never runs models, starts jobs or marks mail seen. Browser-only approvals retain
their original confirmation and security gates; no bridge operation authorizes a `uiOnly` action. The operator must separately configure a safe startup for the
original app; starting this personal API does not launch or reconfigure it.

## Record and synchronization guarantees

- Task idempotency keys record a canonical input hash and the original response. Exact retries
  return that response, even after later edits; reusing a key for different input returns 409.
  Nonempty source type/ID pairs deduplicate captures from both GUI and MCP.
- Task patches require `expected_revision`. Audit records and mutations commit together. A stale
  edit returns 409. Dates without a time mean **23:59:59 on that local date in America/Tegucigalpa**;
  all stored timestamps are UTC. A time without an offset is invalid.
- Check-ins are unique by local date. Every save has an audit version. Saving a check-in or a
  coding result never changes task completion.
- Graph uses inbox delta links and immutable IDs; Gmail uses inbox baseline pages followed by
  history IDs. Pages, fetched messages, response size, request duration and retries are bounded.
  The default call processes at most three pages and 150 messages. Gmail baselines support at
  most 10,000 inbox IDs, continuing over calls. An expired Gmail history cursor starts a new
  baseline. Reconciliation of messages absent from that baseline waits until its final page.
- Provider pages are accumulated before one local transaction commits the snapshot and cursor.
  Failure in a later page never commits the earlier pages. The stored cursor resumes a bounded
  partial sync on the next explicit request.
- Local categories survive later provider refreshes. Automatic categorization is a deterministic
  keyword/importance heuristic; it does not call an LLM or authorize actions.
- `GET /v1/mail/threads` accepts `q`, `category`, `limit` (1–50, default 50) and `offset`
  (0–100000, default 0). It returns `items`, `providers`, filtered `total`, `offset` and
  `next_offset` (null at the end), ordered by received time descending then ID. Pages preserve
  complete message bodies and stay within 1 MiB of serialized UTF-8; large bodies can fill a page
  before its item limit. Continue with the returned `next_offset`, and restart at offset zero
  when changing filters or synchronizing. Overview urgency counts include the entire snapshot.
- Coding snapshots carry UUID, revision, scope, workspace **alias**, hashes and status. No executable,
  raw prompt, log, credential or result body is accepted. Repeating an identical revision is safe;
  stale or changed same-revision data returns 409. `verification` remains `not_run` even when an
  agent process completes successfully.

## Basic mail adapter write safety and recovery

The default configuration allows reads and local categorization only. A configured operator
capability and an explicit API action are both required for writes. Draft creation uses Graph
`createReply` or Gmail `drafts.create`. It never invokes sending. Identical draft requests reuse a
completed action; callers should use a changed body when they intentionally want another draft.

Archiving additionally requires JSON `{"confirmed":true}`; strings and false are rejected. The
service records the remote folder/labels before issuing the mutation, then rereads and verifies
the resulting state. Microsoft undo restores the original folder only while the message remains
in the recorded archive location. Gmail undo restores only the removed `INBOX` label, preserving
unrelated label changes and refusing a message now in spam/trash.

Intent is persisted **before** a write. A timeout, ambiguous response, authorization failure, or
process crash leaves an action requiring review. Restart and repeated requests cannot blindly
retry it. Consult the provider's mailbox and the local `mail_actions` / `mail_events` audit to
reconcile the action. Keep the service stopped during operator-led database reconciliation, make
a SQLite backup first, and do not mark an action confirmed without provider evidence. There is no
automatic recovery that sends, deletes, or assumes a failed HTTP response means no side effect.

SQLite contains personal mail text and audit history in plain text within the protected instance
directory. Back it up with SQLite's backup API or with the process stopped; copying only the main
file while WAL transactions are active can omit changes. Keep backups private too.

## Verification

```sh
.venv/bin/python -m compileall -q herald_personal
.venv/bin/python -m mypy herald_personal
.venv/bin/python -m ruff check herald_personal tests
.venv/bin/python -m pytest --cov=herald_personal --cov-report=term-missing
```

Provider tests use `httpx.MockTransport`; persistence tests use real, temporary SQLite files.
Those tests prove adapter behavior under controlled responses. They do not prove access to a
particular account or authorize changing a real inbox. Deployment, live provider checks, Gmail
consent and real draft/archive/undo must be reported separately with their own evidence.

Protocol references: [Microsoft message delta](https://learn.microsoft.com/en-us/graph/api/message-delta),
[reply drafts](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0),
[message moves](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0),
[Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync),
[Gmail modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify),
and [Gmail draft creation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create).


### Native mail desktop extension

The default mail UI is now native Herald. `/v1/mail-workspace/local` uses a separate strict action
allowlist: `mail-update-item`, `mail-compose-get` (GET upstream), `mail-compose-open`,
`mail-compose-save`, `mail-draft-reply`, `mail-draft-adjust`, and `mail-draft-version` (POST upstream).
The model actions run only on explicit UI requests and use a 120-second upstream timeout. Other
operations retain the 15-second bound. Local actions are rate limited; writes are never retried.
Only the preexisting service runs models or owns drafts. No cookies or UI capabilities are forged.
The MCP read catalog remains separate. See `docs/personal/CORREO-NATIVO.md` for the transition.
