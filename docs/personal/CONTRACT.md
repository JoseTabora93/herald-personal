# Personal workspace contract

Approved scope (2026-10-08): a personal Herald fork with Hoy, Correo, Compromisos, Diario, coding supervision, reusable Hermes skills and deployable always-on services. The user authorized implementation with ECC. Mail provider, cloud host and WhatsApp number remain unconfirmed; implement both provider adapters and make connection status explicit. No live email mutations or external messages during tests.

## Authority and transport

- Python FastAPI personal service, SQLite with migrations and parameterized writes. Default local bind 127.0.0.1:8787.
- /healthz is public and contains no personal data. All /v1 routes require a nonempty HERALD_PERSONAL_TOKEN via Authorization: Bearer. Missing configuration fails closed.
- Desktop calls window.heraldOS.personal.request({method,path,body?}); Electron owns URL/token, reads HERALD_PERSONAL_URL and HERALD_PERSONAL_TOKEN (or token file), uses an allowlisted relative /v1 path and never returns credentials. The root agent owns this IPC seam. Renderer tests may inject a typed client.
- Errors: non-2xx with {detail: string}; no raw upstream bodies, secrets or traceback. JSON times are RFC3339 UTC; display zone America/Tegucigalpa. Dates entered without a time are sent as YYYY-MM-DD and normalized to the end of that local calendar day; an existing precise timestamp is retained when editing unrelated fields.
- Every list returns {items: [...]}. No unsolicited demo seed. Optional fixtures exist only through a development seed command with a dedicated data dir.

## Types

Task: {id,title,description,status,priority,due_at,source_type,source_id,project,agent_task_id,created_at,updated_at,revision}. Nullable strings use null. status=inbox|next|in_progress|waiting|done|cancelled; priority=low|normal|high; source_type=manual|mail|whatsapp|agent. Human commitments have no automatic execution side effects.

MailThread: {id,provider,subject,sender,preview,body,received_at,category,unread,web_url,task_id,archived}. category=urgent|action|waiting|reference|newsletter; provider=microsoft365|gmail. body is plain text, rendered as text. Provider IDs are stored separately from opaque internal IDs.

Checkin: {id,date,accomplished,pending,tomorrow,created_at,updated_at}. date=YYYY-MM-DD; text fields are plain strings. Saving a check-in does not infer or complete tasks by itself.

ProviderStatus: {provider,configured,connected,last_sync_at,error}. Missing credentials are represented honestly, not as an empty connected inbox.

Overview: {timezone,as_of,counts:{open,overdue,urgent_mail,waiting_review},priorities:Task[],recent_checkins:Checkin[],providers:ProviderStatus[]}.

## Routes

- GET /v1/status -> {version,timezone,providers:ProviderStatus[],capabilities:{mail_read,mail_draft,mail_archive,agent_supervision}}.
- GET /v1/overview -> Overview.
- GET /v1/tasks?status=...&q=... -> {items:Task[]}; GET /v1/tasks/{id} -> Task.
- POST /v1/tasks {title,description?,status?,priority?,due_at?,source_type?,source_id?,project?,idempotency_key?} -> Task. Defaults manual/inbox/normal. Replay returns same object; a reused key with changed payload is 409. Source type/id also deduplicates email capture.
- PATCH /v1/tasks/{id} {title?,description?,status?,priority?,due_at?,project?,expected_revision} -> Task; stale revisions 409. GET /v1/tasks/{id}/events -> {items:[{id,kind,created_at,detail}]}.
- GET /v1/mail/threads?q=...&category=... -> {items:MailThread[],providers:ProviderStatus[]}.
- POST /v1/mail/sync {provider} -> {count,provider}. Microsoft Graph or Gmail bounded incremental sync; durable cursor; failure leaves last successful snapshot intact.
- PATCH /v1/mail/threads/{id} {category} -> MailThread (local categorization only).
- POST /v1/mail/threads/{id}/task {title?,due_at?,priority?} -> Task (idempotent conversion).
- POST /v1/mail/threads/{id}/draft {body} -> {id,web_url,provider}; saves provider draft, never sends. Requires explicit mail-write capability configured by operator.
- POST /v1/mail/threads/{id}/archive {confirmed:true} -> {action_id,archived:true}; explicit write capability, record previous folder/labels and verify provider mutation. POST /v1/mail/actions/{action_id}/undo {confirmed:true} -> {restored:true}. If authorization/result uncertain do not blindly retry.
- GET /v1/checkins -> {items:Checkin[]}; PUT /v1/checkins/{date} {accomplished,pending,tomorrow} -> Checkin. Preserve one entry per local date with audit history.
- GET /v1/brief?kind=morning|evening -> {text,generated_at,source_ids:string[]}. Deterministic structured brief from real records; Hermes may narrate it.

## Integration ownership

- Core worker owns services/personal/** (FastAPI, database, provider adapters, tests, dependency manifest). No external account mutations during tests.
- UI worker owns apps/desktop/src/features/personal/**, src/store/personal.ts, src/commands/personal.ts, shell page registrations/MainWindow and command registration. Uses shared/personal.ts written by root; coordinate additions. No Electron/preload edits.
- Hermes worker owns integrations/hermes-personal/** and docs/personal/HERMES.md: stdio MCP calling the HTTP service, skills, profiles, routines templates, supervised coding adapters with stable task/run IDs. Routines remain disabled until destination is supplied. No global configuration changes.
- Root owns shared/personal.ts, Electron IPC/preload, root scripts/CI, environment setup, overall docs, builds, runtime integration, packaging, GitHub publishing and final validation.

## Acceptance

An email becomes the same durable commitment from GUI or MCP. Stale edits and retried creates cannot overwrite/duplicate. Inbox read/classification works without write authority. Drafting never sends. No arbitrary executable/path is accepted for coding execution. Check-ins and tasks survive restart. Unconfigured external services show actionable status. App and service builds, types, tests and secrets scans pass; real account/WhatsApp/cloud tests remain explicitly NOT_RUN unless connected and actually exercised.
