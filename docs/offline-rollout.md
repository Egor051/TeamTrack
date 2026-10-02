# Checklist offline rollout (Phase 6)

Scope: checkbox, percentage, comment and checklist state. Project, stage, item structure, roles, members, assignees and templates remain online only. Build flags `EXPO_PUBLIC_OFFLINE_WRITE_ENABLED` and `EXPO_PUBLIC_OFFLINE_SYNC_ENABLED` are explicit release controls. Persistent runtime metadata does not change env files or deployment configuration. The production browser smoke enables both flags in its local test build.

## Before release

1. Apply `20260929205347_offline_phase6_runtime_retention.sql` to the target database through the approved deployment process. Do not reset or roll back a database with active client data. Verify `private.offline_runtime_config` has `write_enabled=false`, `sync_enabled=false` and no grants to client roles.
2. Run local clean migration reset, SQL/backend tests, security and performance advisors. Review any new findings before deployment.
3. Deploy an application build with both build capabilities intentionally enabled. The remote row must still be **OFF/OFF**. Test a real account on that build, including local cache and account switching.
4. On at least one Android or iOS device, run offline edit → app kill → restart → reconnect → conflict → both resolutions. Exporting native bundles alone is not device acceptance.
5. In the private database configuration, change `sync_enabled=true` while keeping `write_enabled=false`. Existing queues may drain, but no new local operations are created. Watch error and conflict counts and server load.
6. Only after the sync-only smoke passes, set `write_enabled=true`. Exercise online local-first edit, lost-response retry, offline reload/restart, reconnect, failure recovery, access revocation, account switch and PWA update. Watch queue age, failed/conflict counts, pull reset frequency and change-feed size.

The authenticated read-only RPC `public.get_offline_runtime_config()` exposes only booleans, protocol version and update time. Client roles cannot update the private row. An operator may update it in Dashboard SQL with an administrative role:

```sql
update private.offline_runtime_config
set write_enabled = false, sync_enabled = true, updated_at = now()
where singleton = true;
```

Client effective write is `build write AND build sync AND remote write AND remote sync`; effective sync is `build sync AND remote sync`. Remote settings cannot override a disabled build capability. Validated runtime config is persisted in the existing user-scoped `entries` metadata under `runtime:offline-capabilities` (IndexedDB v5 is unchanged; native uses the same cache driver). The snapshot contains `user_id`, `value` (server booleans, protocol version and `updated_at` revision) and numeric `fetched_at`. The 60-second TTL schedules online refresh; offline startup/reload and transport failure can use the last confirmation regardless of age. Online startup and reconnect refresh from the server. Authorization, business or invalid responses persist a blocking null-value snapshot, while server false persists false; neither can fall back to a former true after reload. Every evaluation rereads metadata, and updates notify the existing sync-status BroadcastChannel, so another tab cannot retain stale true. Session/user checks and existing resource/role checks still apply; this metadata grants no project/task permission. Logout/account changes invalidate in-flight responses and volatile state. The sync engine requires fresh server confirmation before replay and after every 20 acknowledged operations in a long queue. Disabled sync preserves the outbox and reports the existing disabled status; write-off/sync-on can drain pending operations.

## Emergency controls

- **Stop new local edits, drain queue:** set `write_enabled=false`, `sync_enabled=true`. Clean online edits continue through the legacy RPC; dirty item chains reject new edits. Existing operations remain durable.
- **Stop all sync traffic:** set both booleans to `false`. Conflict Gate remains visible. “Оставить серверное” is local; “Оставить моё” waits for sync.
- **Re-enable:** verify server health, enable sync first, drain and reconcile, then enable write. Use the sync status and server logs to confirm success.
- **Application rollback:** turn remote write OFF; choose remote sync according to server health; deploy the previous compatible frontend. Keep additive backend objects, feed and operation receipts. Do not drop columns or tables while clients may hold data.

## Feed retention

`private.cleanup_task_item_sync_changes()` deletes changes older than 90 days under the same advisory lock as item writes and advances `private.task_item_sync_retention.retained_after_cursor`. It never touches `private.client_operation_receipts`. Phase 5 clients calling the original pull RPC get an explicit cursor-expired error. Phase 6 clients get `reset_required`, take a server cursor, refresh their known checklist snapshots, then replay changes after that cursor; the pending overlay stays intact.

No Cron job is installed by the migration because its local execution could not be accepted as part of this rollout. After validating the local SQL test and the production `pg_cron` extension, schedule a daily admin-owned job through Supabase Cron/Dashboard with SQL `select private.cleanup_task_item_sync_changes();`. Confirm job owner, first run, run history, floor and feed counts before relying on retention. See [Supabase Cron](https://supabase.com/docs/guides/cron) and its [SQL quickstart](https://supabase.com/docs/guides/cron/quickstart).

## Production acceptance checklist

- [ ] Real login and online local-first edit (one operation ID, one server mutation)
- [ ] Offline edit, F5 or app restart, reconnect and successful reconciliation
- [ ] Conflict: keep mine and keep server, including restart during an unresolved conflict
- [ ] Deterministic failure: retry and explicit local discard
- [ ] Account switch during sync; user B sees none of user A's local data
- [ ] Access revocation, project/task/item archive race
- [ ] Three web tabs, leader close, duplicate leader fallback
- [ ] PWA Service Worker update while pending/conflict exists
- [ ] 500-operation queue, bounded status updates and eventual drain
- [ ] Both kill-switch modes, stale config and re-enable sequence
- [ ] Android/iOS device smoke with process kill

Realtime invalidates data and triggers a sync pass; it does not acknowledge outbox operations. Service Worker caches the app shell, not Supabase data or mutation responses. `last_successful_sync_at` is written only after a complete pull, push and final pull with no remaining operation or conflict.
