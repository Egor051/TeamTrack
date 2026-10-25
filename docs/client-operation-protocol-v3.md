# Client operation protocol v3

Implemented locally on 2026-10-23. Production has not been migrated or configured.
This contract extends the existing mutation wrapper, outbox, cache drivers,
account coordinator and review indicator. It does not introduce another sync
service or address P01.

## Identity and time windows

A durable attempt is identified by `(generation, epoch, user_id, operation_id)`.
The handle also records `protocol_version: 3`, `fingerprint_version: 1`,
`admit_until` and `replay_until`. Only the server issues generation/epoch and
deadlines through authenticated `get_client_operation_context()`.

An epoch starts `open`, becomes `replay_only`, then `retired`. Neither its
deadlines nor its state can move backwards. Issuing a later epoch closes the
previous open epoch. The admission duration is G; replay remains available for H
after admission closes. An operation admitted just before the deadline therefore
still has approximately H to reconcile. Client wall clocks never authorize a
claim or expire a receipt.

`private.operation_clock()` uses `clock_timestamp()` in the migration. It does
not read test-controlled GUCs. Laboratory tests replace this function only in a
disposable database, with changes rolled back or the database removed afterwards.

An expired namespace cannot admit any operation, including one whose receipt has
already been deleted. Missing descriptors fail closed; compacted current-history
epochs at/below the monotonic `retired_through` floor report `expired`. Generation
mismatches report `history_reset`. There are no per-operation permanent
tombstones and no lifetime per-user quota.

## Public API

Only `authenticated` can execute these public functions:

| Function | Purpose |
| --- | --- |
| `get_client_operation_context()` | Issue/reuse the current configured window |
| `execute_client_mutation_v3(generation, epoch, operation_id, name, args)` | Existing allowlisted online business dispatcher |
| `apply_task_item_state_operation_v3(...)` | Versioned checklist completion |
| `apply_task_item_percentage_operation_v3(...)` | Versioned checklist percentage |
| `apply_task_item_comment_operation_v3(...)` | Versioned checklist comment |
| `resolve_client_operation_v3(generation, epoch, operation_id, type, target, payload)` | Read-only business outcome resolution |
| `resolve_legacy_client_operation(operation_id, type, target, payload)` | Resolve an unchanged historical v1/v2/generic identity |

All operation tables, implementation functions, lifecycle routines and the
observability view are private, with RLS enabled and client/service-role direct
privileges revoked. Privileged maintenance requires an appropriate database
operator, not an application client. Authenticated calls also verify that the
Auth account exists and has not been soft-deleted, even with a still-valid JWT.

The fingerprint is SHA-256 over the existing canonical JSONB request helper,
operation type and target. The offline v3 payload includes **expected_version**.
A changed payload/precondition under the same handle is rejected with `22023`.
Historical v2 fingerprints retain their former version-excluding semantics.
Changing canonicalization requires an explicit protocol/fingerprint migration;
do not silently replace this helper on a database upgrade.

## Atomicity and replay

The receipt reservation, business effect and completed outcome commit in one
PostgreSQL transaction. Internal, authorization and unhandled errors roll back
the whole transaction. A bounded allowlist of terminal validation/CAS errors is
recorded using a subtransaction. The original generic dispatcher preserves B01
member-lookup HTTP 400/429 and Retry-After; replay preserves the actual status
and recalculates remaining Retry-After from the stored absolute deadline.

Known identical handles replay without consuming another slot, rate token or
business effect. Concurrent claims serialize through the live budgets and
receipt identity. A successful offline semantic no-op still advances the CAS
version; an offline conflict is a terminal outcome for that attempt. Rebasing a
v3 conflict creates a **new attempt ID** after explicit conflict resolution.

Replay is not a new authorization grant. Sensitive historical item/object
bodies are returned only when current read access still exists, using existing
ACL helpers. Otherwise the response is terminal `result_redacted`, without the
old body. This rule also applies to the new legacy resolver. Safe own scalar
acknowledgements can remain available. Entity/account deletion never cascades
receipt deletion, and cannot resurrect an entity during replay.

| Resolution | Meaning and client action |
| --- | --- |
| `completed` | Verified receipt; consume its real success/error/CAS outcome |
| `unknown` | The open namespace has no confirmed receipt; retain handle and optionally retry this same attempt |
| `not_applied` | Admission is irreversibly closed and writers drained; this handle did not execute |
| `window_closing` | A deadline crossed while waiting; resolve in another transaction before drawing a historical conclusion |
| `expired` | Replay history no longer available; stop automatic sending and review current state |
| `history_reset` | Server history generation changed; stop automatic sending and review |
| `result_redacted` | Execution is terminal, but its historical body cannot be disclosed |
| `invalid_epoch` | Forged/unsupported namespace; fail closed |
| `never_sent` | Client-only classification: v3 draft never acquired a durable handle, so no business POST was possible |

The mutation HTTP envelope uses 410 for expired, 409 for reset/not-applied/closing,
and 400 for invalid epochs. Resolver results are structured states. Checklist
replay redaction is a terminal structured result; generic mutation redaction is
HTTP 409. A client must inspect the operation code/state, not just retry every
409 or every 5xx. Admission pressure uses `TT_RECEIPT_POLICY`,
`TT_RECEIPT_LIMIT`, `TT_RECEIPT_RATE`; the unchanged attempt survives rejection.

## Fences, locks and lifecycle

Order: lineage fence → epoch fence → global/account budget → receipt → existing
business locks. Legacy paths use lineage → legacy fence → legacy budget.
Issuance/history rotation take the lineage fence exclusively. Claims/replays
share it. Epoch closure and GC take the epoch fence exclusively **before**
entering the budget/receipt path. Never acquire shared epoch locks then upgrade
them in two cleaner workers.

`private.retire_client_operation_epoch()` also persists due admission closure.
`private.run_client_operation_lifecycle(batch)` processes at most eight due
epochs and bounded per-account batches. The normal batch is 500, accepted range
1–5000. Deletes and exact live count/byte decrements occur in the same
transaction. Interruption rolls both back. Empty account budget rows disappear;
empty retired epoch descriptors are removed after their contiguous floor can
advance. Legacy cleanup occurs only after irreversible legacy retirement.

The migration registers `tasktrace-operation-lifecycle` every five minutes only
if pg_cron is already installed, following the project's existing convention.
The cron command sets a top-level 20-second statement timeout. Without pg_cron,
the callable function is installed and scheduling must be arranged at controlled
release. No extension or production scheduler was changed during this work.

## Configurable capacity

`private.client_operation_window_policy` deliberately starts with NULL v3 values.
An unconfigured v3 context fails closed with `TT_RECEIPT_POLICY`. This is a
release prerequisite, not a usable production SLA:

| Field | Required operational decision |
| --- | --- |
| `admission_seconds` | G: maximum time a handle can first execute |
| `replay_seconds` | H: replay grace after admission closes; must exceed 60 seconds |
| `max_receipts`, `max_logical_bytes` | Live per-account capacity |
| `max_global_receipts`, `max_global_bytes` | Whole-journal capacity |
| `max_request_bytes`, `max_result_bytes` | Bounded input and worst-case outcome reservation |
| `new_per_minute` | New-claim pressure; identical replay bypasses it |
| `legacy_admit_until`, `legacy_replay_until` | Explicit legacy cutover, second strictly later than first |

Logical reservation is `192 + operation_type UTF-8 bytes + max_result_bytes`;
completion shrinks it to the actual bounded outcome. This is an accounting bound,
not a physical disk/WAL estimate. Heap headers, indexes, TOAST, dead tuples,
autovacuum lag, backups and WAL need separate physical headroom. The global
budget row serializes new effects; its measured contention limits capacity.

Tests use **laboratory-only** G=1 day, H=90 days and deliberately large limits
from `scripts/receipt-test-policy.mjs`; some scenarios lower slots to one.
They are not recommended production values. Size live capacity for the arrival
rate over G+H plus cleanup lag, outcome size/reservation, burst concurrency and
retained legacy rows. At five-minute cadence a backlog must be checked against
the number of active accounts/epochs, the per-account batch and transaction
time. Raise cadence/batches only after measuring contention and physical growth.

`private.client_operation_lifecycle_status` exposes due states, retained rows and
cleanup lag to operators. Observe global/account counts and bytes, oldest due
epoch, statement failures, table/index size, dead tuples, autovacuum and WAL.
DELETE releases logical capacity immediately; it does not shrink heap files.
Repeated laboratory cycles verified bounded retained rows/metadata and admission
recovery; no production-capacity guarantee follows from those measurements.

## Client and local storage

Online mutations retain the existing shared cache envelope and tab binding.
The UUID/draft is saved before context acquisition; the full handle is saved
transactionally before the business POST. A failed context request cannot cause
the next retry to mint another draft UUID. Timeout, Auth/quota rejection and
lost responses retain the original identity and settle `running` to `unknown`
where the account is still current. Account epochs and bounded operations fence
stale completions and writes.

`executeMutation` accepts `{mode: 'new' | 'retry'}`. Explicit retry requires an
existing binding/envelope and never generates an ID when it is missing. Explicit
new cannot overwrite an unresolved older envelope or claim its success, even
when arguments are identical. Feature callers declare new; the same open profile
form explicitly retries its own uncertain/quota-blocked attempt. The review UI
also declares retry. The compatibility default can resume only its own tab
binding, never an observed foreign unknown/running envelope. Account and
operation-specific Web Locks still fence capture, dispatch and conditional
retirement. Full handle, rather than matching arguments, identifies a retry.

Expired/reset/redacted attempts enter `review`. The existing indicator preserves
and displays the draft, reads current RLS-limited state, and requires an explicit
acknowledgement/keep-server choice. An open unknown outcome cannot be acknowledged
as a completed action or silently converted to a fresh create. Current state is
not proof of a lost historical result. Acknowledging an old draft does not undo
a possible server effect; subsequent user saving is a distinct intent.

IndexedDB keeps the released schema version 5: v3 needs additive record fields,
not new stores/indexes. Existing pre-release v6 databases open without a version
downgrade or deletion. SQLite remains version 6. Existing entries, operations and
conflicts survive the upgrade. Nullable `operation_handle` and
`logical_operation_id` fields preserve historical rows. Binding is transactional
and first-writer-wins. New outbox rows use v3, with a handle acquired only when
first sending; a long-offline draft therefore does not expire before ever being
bound. Explicit rebase replaces a bound v3 attempt only after a confirmed conflict,
updating dependent/conflict references atomically while retaining logical IDs.
A pending bound attempt can already have committed: repeated `chooseMine` resumes
its exact generation/epoch/UUID and CAS version, including after restart or a
failed durable ACK. Never-sent dependent drafts retain their IDs. Rebase checks
the current statuses again inside the storage transaction; neither pending
unknown nor review may be changed into a fresh attempt. Legacy v2 keeps its UUIDs/preconditions
contract. Pre-v2 rows cannot be guessed into a newer namespace and enter review.
Review chains stop automatic replay without a global conflict gate; unrelated
item chains can proceed. Existing genuine CAS conflicts still use ConflictGate.

`chooseMine` uses the existing recovery queue and `tasktrace-sync:<account>` lock,
with account/runtime fencing before reading the conflict. A terminal response
settles that action after one refusal. Its storage transaction retains the
reviewed row and full handle, releases only the conflict metadata, and restores
dependent drafts to pending without changing their dependencies. Reopening the
app or repeating the old conflict action does not resend a reviewed attempt.
The existing indicator provides read-only resolution and explicit reconciliation.
A concurrent keep-server action cannot discard pending unknown or ACKed but
unreconciled rows; its storage transaction requires conflict/review statuses.

Online envelopes use `sync:mutation:v3:<name>:<target>`, invisible to an old
online mutation parser's legacy key. Existing envelopes move in one conditional
cache transaction without changing IDs or handles. New v3 attempts/rebases use
application-defined UUIDv8. The legacy claim rejects these IDs permanently,
including after GC; retained pre-release UUIDv4 v3 receipts also fence their IDs.
When initializing release policies, legacy admission must end no later than GC
eligibility of an existing pre-release v4 receipt. An old native sync rejects v3
rows without interpreting them as legacy. Rollback must use the separate
v3-compatible artifact; unmodified v5 JS cannot open a pre-release v6 database.

The sixth forward migration adds multi-user bounded GC with global-before-user
budget locks and round-robin service of eligible epochs. Cleanup admits no new
work into retired epochs; all counts/bytes update atomically. The cron retains
an external 20-second statement timeout and 500-row batches, up to 8 epochs.
The release manifest and maintenance fence cover all six migrations. Both policy
sets initialize in one transaction under a server write fence before reopening.
Direct public mutations validate the active Auth account and stop new legacy
business work after irreversible cutover. Existing RLS/ACL checks remain in force.

## Legacy cutover and release

The legacy receipt table is not renamed, truncated or converted. One shared
claim function fences every old receipt path. Until explicit cutover it preserves
known UUIDs, business outcomes and v2 fingerprint semantics. Once admission
closes, unknown old handles cannot execute. Known replay remains until legacy
retirement; then all old calls expire before receipt GC. Rolling back wall time
or changing cutoff configuration cannot unset persisted closed/retired flags.
Do not set cutoffs without considering the oldest supported/offline clients.

Before a controlled release: independently review migrations and current schema;
measure/configure G/H/budgets/cutoffs; ensure server-first compatibility; verify
scheduler permissions/timeout and cleanup lag; validate supported clients and
real devices; resolve the dependency-policy gate; stage a traffic-fenced restore
drill and rollback/runbook. These are release prerequisites. No automatic
production rollout, feature-flag change or P01 work is included here.

## Backup / PITR boundary

Database state alone cannot detect a restored lost future. Required sequence:

1. Fence **all external mutation traffic** and stop workers/client access.
2. Restore the backup/PITR target and verify its consistency.
3. As the privileged database operator, call
   `select private.rotate_client_operation_history();` and commit it.
4. Verify a new random generation, retired old epochs, closed/retired legacy
   admission and rejection of a handle from the lost future.
5. Resume traffic only after these checks. Clients reconcile `history_reset`
   explicitly against current authorized state.

A tab retaining a review binding after another tab removed the shared envelope
restores that review under the account fence for visible reconciliation. It
cannot overwrite a newer shared envelope or resend the reviewed command.

The rotation shares the same lineage fence as claims. A real disposable Docker
hard-crash/restore test exercised this order. Rotation without the external
traffic fence, or opening the restored database first, is **not safe**. Neither
DB receipts nor this client can promise exactly-once execution across an
unfenced history rollback or after permanent loss of all local handles.

## Reproduction

Use only disposable local databases. Important entry points:

```text
node scripts/operation-window-integration.mjs
node scripts/operation-window-integration.mjs --upgrade
node scripts/operation-window-crash.mjs
node scripts/operation-window-load.mjs
node scripts/run-audit-sql-tests.mjs --fresh --advisors
node scripts/run-audit-sql-tests.mjs --advisors
node scripts/regression-mutation-browser.mjs --repeat=100
node scripts/regression-mutation-browser.mjs --webkit --repeat=100
node scripts/run-security-integrations.mjs scripts/operation-window-ui-browser.mjs
```

For an offline advisor run, `TASKTRACE_ADVISOR_SQL_FILE` may point to the official
Splinter file at commit `fccca4b1c4d8b48b8ccd69bd6b30e84adcb92975`; the harness
requires SHA-256 `d8d558baad3e03832e521c527907fa50a9a172fabd899dd0f5c2504a5a0e9349`.
Failure diagnostics are saved before browser cleanup under `.expo/r03/`;
request, lock, account, durable handle and independent SQL evidence are correlated
by host time, tab, request and operation ID. Artifacts contain synthetic local
identities only and are not committed.
