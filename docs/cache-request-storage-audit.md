# Request and storage optimization audit

Audit date: 2026-10-07. Baseline: clean `main`; `npm test` passed 42 files / 425 tests. No hosted database, flags or schema changes are planned.

## Call map before changes

| Trigger | Functions | Supabase requests (one small page per query) | Local writes |
| --- | --- | --- | --- |
| `/projects` focus / permissionVersion / item broadcast / recovery | `listProjects`, `listMyTasks`, `fetchUnreadCount` | projects, auth/user, own project_members; task_assignees, tasks, projects; notifications count | projects:status, my-tasks:user; visibility tombstones |
| Project focus / connected / projects, tasks, members, items events | `getProject`, `listTasksWithStats` -> `listProjectTasks` | projects, auth/user, project_members; tasks, task_items stats, task_assignees | project:id, tasks:project, task-stats:project:mode |
| Stage focus / connected / events / sync changes | `getTask`, `getProject`, repository items, members, assignees, editors, role, overrides | tasks; projects, auth/user, project_members; tasks access + task_items; project_members + profiles; task_assignees; list_task_item_last_editors; get_my_task_role; admin-only overrides | corresponding confirmed models; outbox overlay is applied after reads |
| Back to project | same project loader | the entire project chain again, despite loaded IndexedDB models | the same model keys |
| Permission subscribe + SUBSCRIBED + connectivity + data broadcast | PermissionProvider.revalidate | project_members + task_assignees each time | no useful ACL snapshot; increments global version |
| Progress / history | project / task / items / members + audit | repeated project and identity reads; bulk items; audit_log; history item-ID and task access queries | daily-audit and 90-day history models |
| Template loader | getCurrentUser + list/get templates | auth/user plus template RPCs on every load | templates and template detail / item models |
| Freshness / reconnect / sync | coordinator -> runtimeCapabilities -> pull -> push -> pull | forced runtime config; first pull; forced runtime config even for empty push; second pull | capabilities, cursor; confirmed models only on meaningful change |
| Preparation / invalidation / resume | bootstrap -> manifest -> pages -> verification manifests -> commit | manifest; missing/changed pages; Basic verification; optional Extended verification | revision-scoped raw batches, read models, certificates, metadata |
| Changed dataset with unchanged pages | reusable-page inventory -> download loop | unchanged page HTTP is skipped | **unchanged JSON copied into each new revision key**; previous keys removed only after successful completion |

## Confirmed causes and invariants

- `readThroughCache` chooses IndexedDB first only offline/degraded; online route calls always execute the server callback. CAS and access epochs already fence late responses and must remain.
- Checklist repository has single-flight per list, but schedules a server refresh on every online local read. Its access query is meaningful when refreshing, not when reusing a fresh confirmed list.
- Global permission subscriptions include projects/tasks/assignment data. Assignment is not an access source: `private.task_role_of` joins project_members and nullable task_members overrides. Ordinary updates close resource channels and cause global loader cascades.
- Resource subscriptions independently reload on focus, connected and every table event. Broadcast payloads contain only table/operation; the topic gives project/task/user scope. No payload is an authorization grant.
- Sync's outer run and empty push force capability checks, then run two pulls without checking whether any mutation was sent.
- Bootstrap hashes already support logical reuse, but raw batch keys include revision/offset. Certificates and restoration use those keys. Content pages need checksums for resumable staging, compatibility with existing certificates, and GC under the existing lease/metadata CAS.
- Bootstrap `all` duplicates the combined `active` + `archived` item partitions. Retaining the two partitions avoids changing outbox/version-capture semantics and makes `all` a cheap local projection. Task statistics and other useful materialized models remain.

Planned boundaries: keep RLS/RPC as authority, immediate ACL quarantine, finite freshness plus explicit invalidation, user-scoped in-flight reads, cross-tab durable invalidation, the existing database/stores/locks, and atomic snapshot replacement. GC may sweep bootstrap pages only; pending operations, conflicts, cursor, receipts and capability state are excluded.
