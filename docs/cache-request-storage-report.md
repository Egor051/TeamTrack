# Оптимизация запросов и локального хранения TeamTrack

Дата: 2026-10-07. Исходная версия: `4810e3efe11b32bfb1e037869f3de36f4082e5ca`, чистый `main` до изменений. Реализованы клиентские изменения, instrumentation и регрессии. SQL migrations, API/RPC signatures, hosted Supabase, production flags, зависимости и schema IndexedDB не менялись. Отчёт фиксирует реализацию и локальные измерения до публикации.

## 1. Root causes

Предварительная карта trigger → function → requests → writes находится в [аудите](cache-request-storage-audit.md). Онлайн-чтения обращались к серверу даже при наличии свежего подтверждённого кеша. Checklist repository объединял параллельные запросы, но запускал новую проверку при каждом повторном чтении. Route loaders независимо реагировали на focus, SUBSCRIBED, permissionVersion и отдельные Realtime events.

PermissionProvider считал изменения проектов, задач и назначения исполнителей глобальными изменениями доступа. Он повторно читал assignments и увеличивал version без сравнения memberships. Identity-only loaders вызывали Auth `getUser`. Пустой sync принудительно проверял runtime config дважды и выполнял два pull. Bootstrap пропускал HTTP для неизменённых страниц, но копировал их JSON в новые revision keys. `items:…:all` полностью дублировал две другие item partitions.

## 2. Изменённые файлы

Основные изменения:

| Область | Файлы |
| --- | --- |
| Общие чтения и invalidation | `src/lib/local-cache/cache.ts`, `read-freshness.ts`, `read-model-events.ts`, `repository.ts` |
| Bootstrap/storage | `src/lib/local-cache/bootstrap.ts`, `bootstrap-types.ts`, `bootstrap-pages.ts`, `bootstrap-models.ts`, `driver.web.ts` |
| Sync/capabilities | `src/lib/local-cache/sync.ts`, `runtime-config.ts` |
| Auth/permissions/Realtime | `src/features/auth/auth.ts`, `AuthProvider.tsx`, `PermissionProvider.tsx`, `src/lib/supabase/realtime.ts` |
| Loaders и mutations | `src/features/projects/projects.ts`, `src/features/notifications/notifications.ts` |
| UI | overview/project/task, members, оба progress, history, templates, notifications; общий `use-read-model-updates.ts` и `refresh-scheduler.ts` |
| Проверки | новые `cache-first-regressions.test.ts`, `permission-provider-cache.test.tsx`, `read-refresh-scheduler.test.ts`; обновлены cache/auth/bootstrap/repository/runtime/realtime/lifecycle tests |
| Измерения | `scripts/offline-navigation-browser-smoke.mjs`, `offline-navigation-instrumentation.js`, `measure-read-model-storage.mjs`; content page fixture в `account-offline-browser-smoke.mjs` и TTL-aware `phase6-browser-smoke.mjs`; audit/report и JSON evidence |

## 3. Online cache

Production loaders используют `readCachedModel` поверх прежнего driver/entries store. Подтверждённый кеш возвращается до HTTP. Freshness равен 60 секундам; свежий неинвалидированный model не вызывает HTTP. Stale/soft-invalidated model доступен сразу, а в фоне идёт один refresh на user/key/account epoch/invalidation generation. Timestamp из будущего также вызывает revalidation. Manual refresh принудительно проверяет сервер.

Identity/account, denial epochs и CAS проверяются до и после асинхронных операций. При конкурирующем pull/commit HTTP-ответ уступает новому локальному snapshot. Online local provenance хранится отдельно от offline/transport fallback: cached UI не означает offline edits. Pending operations накладываются поверх подтверждённых данных и не записываются в серверный snapshot.

## 4. Invalidation/revalidation и безопасность

В существующем entries store сохраняются маленькие `read:stale:<model>` markers. В памяти устанавливается немедленный fence, до IndexedDB I/O. `data` допускает SWR; `refresh` требует server check онлайн; `access` запрещает показ старого model до новой успешной RLS/RPC-проверки. Известные 401/403/invalid JWT/revoke и business errors не подменяются кешем. Transport fallback использует только допустимый подтверждённый кеш.

Чтение ожидает завершения уже запущенной записи invalidation перед захватом CAS baseline. Это устраняет найденную в браузере гонку reconnect: успешная RLS-проверка больше не теряет CAS из-за запоздалой записи собственного ACL marker. Старый ответ после нового ACL event не записывает новый запрет; он отбрасывается либо возвращает уже проверенный более новый model. Повторные серверные отказы не создают бесконечную цепь UI reload.

Durable marker виден после reload и другим вкладкам. Read commits распространяются через существующий BroadcastChannel. In-flight requests объединяются внутри одной вкладки; межвкладочные lease/Web Locks/CAS bootstrap и sync сохранены. Broadcast payload не предоставляет право доступа.

Authoritative bootstrap commit снимает markers только для своих подтверждённых models, с guards по исходным marker values и invalidation epoch. Новое ACL event во время snapshot/commit вызывает restart. Pending ACL исключает ложный readiness даже при сохранённом предыдущем certificate.

## 5. Realtime reload storms

Обычные события обновляют затронутые items/stats/assignees/editors/history/overview models по topic scope. Burst собирается в окно 150 мс; refresh, уже выполняющийся на экране, получает максимум одну последующую итерацию. UI читает новый model после успешного фонового commit.

`project_members` и `task_members` остаются ACL sources. Resource DELETE также устанавливает quarantine. Permission version больше не меняется на ordinary item/project/task/assignment events и на неизменённом membership poll. Assignments не читаются PermissionProvider. Initial query + проверка после SUBSCRIBED сохранены, включая subscription race; reconnect требует server revalidation и проверяет пропущенные role/revoke изменения. Само событие восстановления сети не превращается в ACL quarantine: подтверждённый inactive cache остаётся доступным при следующем offline cycle. Закрытие resource topics и ACL fence происходят сразу, без debounce.

## 6. Auth requests

`getCurrentUser` теперь берёт identity из `getReadSession`; online requests и mutations по-прежнему проверяются RLS/RPC. Старый authoritative путь сохранён как `getVerifiedCurrentUser`. В восьми измеренных browser windows `/auth/v1/user`: **24 → 0**.

Online expired/invalid session не выдаёт сохранённый model. Существующая read-only семантика уже сохранённой expired session при подтверждённом offline сохранена; она не разрешает новый push. Account switch, logout/relogin и token refresh проверены локальными регрессиями. Это не отменяет серверную проверку credentials при онлайн-операции.

## 7. Sync/runtime config

Обычный freshness/pull использует действительный persisted capability snapshot с TTL 60 секунд, в том числе после startup. Timestamp из будущего требует новой онлайн-проверки и не может вытеснить свежий отказ при сохранении ответа. Пустой push не делает force-fetch. Второй pull выполняется после отправки mutation или reconciliation; pre-pull перед pending replay сохранён.

Pending replay и explicit conflict action требуют новой authoritative capability confirmation; одна подтверждённая run не повторяет её немедленно без причины. Подтверждение обновляется после TTL или очередной группы 20 operations. Серверный false/error, exactly-once receipts, lost ACK, synced_unreconciled, conflict и durable failed operations сохраняют прежнюю семантику. `OFFLINE_TICK_MS = 20_000` и единственный coordinator pipeline сохранены.

## 8. Физическое хранение bootstrap pages

Page хранится один раз в namespace пользователя по ключу `bootstrap:page:<dataset>:<server-content-hash>`. JSON envelope содержит hash, rows и checksum для обнаружения случайной порчи. Manifest/certificate ссылаются на эти physical pages; revision/offset больше не создают копию неизменённых rows.

Старые `bootstrap:batch:<dataset>:<revision>:<offset>` certificates читаются совместимо. Первая успешная подготовка переносит certified legacy pages в content keys без HTTP; старые keys удаляются после публикации нового certificate. Checksum не является механизмом авторизации.

## 9. Reuse и garbage collection

Inventory проверяет содержимое и длину существующих pages. Неизменённая content page не скачивается и не переписывается. Retained set включает verified Basic, verified Extended и текущий resumable snapshot. Sweep ограничен `bootstrap:page:`/`bootstrap:batch:` данного пользователя, выполняется под прежним lease/lock с metadata CAS после successful commit. Outbox, conflicts, cursor, receipts и runtime authorization state не затрагиваются.

При interruption прежний verified snapshot остаётся доступным, если не пришёл авторитетный revoke. Valid staging pages используются повторно. Страницы abandoned revision удаляются после следующего successful commit. Отсутствующая/повреждённая page восстанавливается адресно.

## 10. Read models

Убрана большая физическая `items:<task>:all`. Каноническое item содержимое разделено на непересекающиеся active/archived partitions; all вычисляется локально с version-aware dedup и стабильным порядком. CAS включает обе partitions и markers. Это сохраняет прежние enqueue/reconcile/version-capture paths без второго хранилища.

Task stats, members, roles, daily history, template details и overview оставлены как полезные materialized models. Content pages также оставлены для проверки certificates и resume. Полная нормализация этих представлений потребовала бы отдельной переработки offline protocol.

Basic overview сохраняет только unread count. Полное окно notifications создаётся для самой страницы/Extended readiness, где rows действительно нужны. Badge не скачивает и не сохраняет notices целиком.

## 11. Результаты проверок

`npm test` — **45 файлов / 463 теста**, DB connection policy, TypeScript и lint PASS. Отдельная AuthProvider регрессия исполняет SDK event `TOKEN_REFRESHED`: новые credentials заменяют прежние, account epoch и fresh cached profile сохраняются без profile RPC.

`node scripts/run-audit-sql-tests.mjs` — PASS: полный migration upgrade на legacy valid data в отдельной БД, 13 SQL suites, template edit/reorder/copy/delete concurrency. Общий development DB этим harness не сбрасывался.

`npm run test:backend` — PASS: настоящий local Data API/Auth/Realtime, GoTrue web/native PKCE, two-session concurrency. Bootstrap HTTP: 15 datasets × 10 rounds = 150 отдельных HTTP pages; controlled mutation вернула PT409, свежий snapshot восстановился с HTTP 200. Hosted данные не использовались.

Production Web/PWA и Android/iOS/Web export — PASS. Offline-navigation smoke повторно прошёл на финальной сборке: восемь routes с 0 HTTP, 70–196 мс; expired-session read-only routes — 80/92 мс и 0 HTTP. Degraded startup — 88 мс и 5 failed requests для обнаружения transport failure; последующие project/task routes — 36/26 мс и 0 data HTTP. Recovery — 65 мс до UI и 9 data HTTP. Connectivity probes считаются отдельно. [Компактные timing counts](cache-optimization-evidence/offline-navigation.json).

`node scripts/account-offline-browser-smoke.mjs` — PASS: automatic Basic/PWA assets, cached navigation и direct offline reload, три online/offline cycles, coalesced recovery/Retry, focus/visibility/tabs, 45 секунд idle с 0 HTTP, адресное восстановление одной удалённой content page, desktop/390 px status layout. Проверены durable offline checkbox/percentage/comment, три серверные receipts и ACK/reconcile, cross-tab write disable с сохранённой pending operation, interruption Extended на 94% и последующее восстановление, bounded history/notifications и Extended → Basic offline.

`node scripts/phase6-browser-smoke.mjs` — PASS: local-first online edit, offline edit/F5/reconnect, conflict persistence/server resolution, remote write kill switch, multi-tab queue с одной receipt, service-worker update с pending operation, failed operation после revoke/F5 и explicit retry после восстановления membership. Kill-switch fixture теперь ожидает реальное истечение 60-секундного TTL перед startup-проверкой изменённого серверного флага, затем отдельно ждёт подтверждённое разрешение перед следующим offline probe.

Полная проверка production hosting и запуск приложения на физическом Android/iOS не выполнялись.

Новые регрессии покрывают unchanged pages, один изменённый page, interruption/resume/orphan cleanup, legacy certificates, 20 reload cycles, cache-first immediate results, dedup, manual server check, targeted invalidation, durable ACL, account epochs, concurrent reads/pull, pending overlay, business errors, expired/invalid online identity, immediate ACL, coalescing и пустой sync против authoritative replay.

| Invariants | Выполненная проверка |
| --- | --- |
| Offline cold start, online/offline/reconnect, offline reload | Account и navigation browser smoke; auth/route recovery tests |
| Reload во время preparation, interruption/resume, missing/corrupt pages | `offline-bootstrap.test.ts`, lifecycle tests; browser Extended interruption и адресное восстановление page |
| Account switch/logout, token refresh, expired/invalid session | Auth/cache/runtime tests; SDK token event в AuthProvider; local PKCE HTTP; expired offline browser reload |
| Project/task revoke, member/override roles, archive/delete | Cache denial races, permission/realtime/stage visibility tests, local RLS SQL/Data API; browser project revoke/restore |
| Tabs, competing sync/bootstrap/read, locks и CAS | Bootstrap/repository/runtime races, isolated SQL concurrency; browser one receipt и cross-tab disable |
| Pending edits, lost ACK, synced_unreconciled, conflict | Outbox/sync/reconciliation tests; browser ACK/reconcile, conflict resolution, durable failed и explicit retry |
| Basic/Extended и day rollover UTC+3 | Bootstrap readiness/rollover tests; browser Basic → Extended → Basic |

## 12. Supabase HTTP requests до/после

Production static PWA, Chromium, local Supabase, одинаковая небольшая fixture, прогретый Basic cache. В каждый window входят запросы приложения и membership/sync lifecycle, после действия ожидается settling минимум 2,5 секунды. Navigation упражняет настоящие routes через history/popstate. Focus/visibility события синтетические. Connectivity probes подсчитаны отдельно. Fixture setup, внешняя mutation владельца и server-side instrumentation не включены в browser request count.

| Сценарий | До | После |
| --- | ---: | ---: |
| Открыть `/projects` | 22 | 3 |
| Открыть project | 27 | 3 |
| Project → task | 89 | 4 |
| Task → project | 24 | 3 |
| Realtime: изменить один item | 6 | 2 |
| Foreground без изменений | 0 | 0 |
| Manual refresh | 4 | 3 |
| Offline recovery | 19 | 8 |
| Data/Auth/RPC всего этих windows | **191** | **26** |
| Connectivity probes, отдельно | 12 | 12 |
| Все Supabase HTTP, включая probes | **203** | **38** |

Остаточные две membership проверки на remount закрывают initial subscription race; один pull обеспечивает freshness. Task впервые получает last editors, которых нет в Basic cache. В финальном recovery window выполняются memberships, overview, profile, runtime config и один pull. Количество manifest/page запросов зависит от того, когда coordinator выполняет подготовку относительно окна; здесь их нет. Это измерение отдельных окон, а не суммарного трафика всей сессии.

| Endpoint, сумма восьми windows без probes | До | После |
| --- | ---: | ---: |
| `/auth/v1/user` | 24 | 0 |
| `/rest/v1/project_members` | 40 | 12 |
| `/rest/v1/projects` | 24 | 2 |
| `/rest/v1/tasks` | 12 | 0 |
| `/rest/v1/task_items` | 5 | 1 |
| `/rest/v1/task_assignees` | 26 | 3 |
| `get_my_task_role` | 7 | 0 |
| `list_task_item_last_editors` | 7 | 1 |
| `get_offline_runtime_config` | 12 | 1 |
| `pull_task_item_changes_v2` | 12 | 5 |
| `get_offline_account_manifest` | 2 | 0 |
| `get_offline_account_page` | 0 | 0 |
| `get_my_profile` | 5 | 1 |
| `/rest/v1/profiles` | 7 | 0 |
| `list_task_member_overrides` | 7 | 0 |
| `/rest/v1/notifications` | 1 | 0 |

Полные endpoint/probe counts: [before](cache-optimization-evidence/requests-before.json), [after](cache-optimization-evidence/requests-after.json). Это локальное измерение конкретных windows, не прогноз абсолютного production трафика.

## 13. IndexedDB size/records до/после

| Измерение | До | После |
| --- | ---: | ---: |
| Browser, warm Basic, UTF-8 serialized entries | 36 491 B / 51 records | 35 660 B / 50 records |
| Browser, после сценариев с реальным изменением данных/reconnect | 35 943 B / 48 records | 42 536 B / 78 records |
| Browser bootstrap page count, warm → после | 10 → 10 | 10 → 10 |
| `storage.estimate().usageDetails.indexedDB`, warm → после | 126 976 → 126 976 B | 126 976 → 135 168 B |
| Read models: одинаковые 1001 items, комментарий 690 B, 10% archive | 1 740 455 B / 20 records | 871 791 B / 19 records |
| Item read models той же fixture | 1 737 451 B / 3 records | 868 787 B / 2 records |

Последние две строки — фактическая сериализация исходной функции из `git show 4810e3e:…` и новой функции на одинаковых rows, а не полный browser DB. [Serializer evidence](cache-optimization-evidence/model-storage.json), воспроизведение: `node scripts/measure-read-model-storage.mjs 4810e3e`.

Отдельный integration regression с 1001 items и 20 preparation/reload cycles: **49 records, 13 content pages, 1 847 602 B JSON** во всех 21 samples финального запуска; **0 page writes, 0 page HTTP requests** после первой подготовки. Это fake IndexedDB, фактические production bootstrap/driver functions. [Cycle evidence](cache-optimization-evidence/storage-cycles.json).

Разбивка той же маленькой browser fixture после сценариев:

| Категория entries | До: bytes / records | После: bytes / records |
| --- | ---: | ---: |
| Bootstrap raw pages | 8 910 / 10 | 9 707 / 10 |
| Bootstrap metadata/certificates | 8 637 / 1 | 8 504 / 1 |
| Projects/tasks и их списки | 4 546 / 8 | 4 548 / 8 |
| Item partitions | 3 679 / 6 | 2 024 / 4 |
| Task stats | 1 780 / 4 | 1 778 / 4 |
| Daily history | 2 969 / 2 | 2 966 / 2 |
| Notifications | 0 / 0 | 161 / 1, только count |
| Invalidation markers | 0 / 0 | 7 238 / 30 |

Прирост после изменяющих browser scenarios/reconnect связан прежде всего с 30 маленькими `read:stale:` markers. Их число ограничено существующими models; повторная invalidation обновляет те же keys. Это разовая metadata overhead, а не серия duplicate content pages. Физическая прибавка IndexedDB в этом запуске — 8 KiB. Физическая оценка всего origin включает PWA caches и service worker; изменение bundle size не следует приписывать IndexedDB. LevelDB compaction не гарантирует немедленное уменьшение физических файлов.

## 14. Ограничения и компромиссы

SWR может показывать старое подтверждённое значение до background refresh при обычном data event; ACL quarantine этого не допускает. TTL применяется при чтении, дополнительно работают Realtime, reconnect/focus и coordinator. Read requests разных вкладок могут выполняться параллельно; durable markers и CAS сохраняют correctness.

ACL user-topic сообщает table/operation без affected resource ID, поэтому global quarantine при ACL событии сознательно консервативен. После interruption staging pages остаются до следующего успешного sweep. Statistics/history/content pages по-прежнему частично дублируют предметные данные. Small fixture показывает прежде всего request/lifecycle эффект; serializer и 20-cycle regression измеряют крупные payloads отдельно.

Сохранена прежняя offline read-only семантика expired persisted session; replay проверяется отдельно и fail closed. Локальные tests не доказывают поведение конкретного мобильного устройства, браузера пользователя или hosted stack.

## 15. Возможные отдельные оптимизации

Можно отдельно измерить нормализованные items с indexed projections вместо больших partitions, bulk-refresh project progress для очень многих задач, grouped task refresh при полном pull reset, более точные resource IDs в ACL broadcasts и необязательный межвкладочный read single-flight. Эти изменения сейчас не требуются для correctness и повлекут отдельные protocol/schema/lifecycle tradeoffs.

## Полный список файлов

- `docs/cache-optimization-evidence/model-storage.json`
- `docs/cache-optimization-evidence/offline-navigation.json`
- `docs/cache-optimization-evidence/requests-after.json`
- `docs/cache-optimization-evidence/requests-before.json`
- `docs/cache-optimization-evidence/storage-cycles.json`
- `docs/cache-request-storage-audit.md`
- `docs/cache-request-storage-report.md`
- `scripts/account-offline-browser-smoke.mjs`
- `scripts/measure-read-model-storage.mjs`
- `scripts/offline-navigation-browser-smoke.mjs`
- `scripts/offline-navigation-instrumentation.js`
- `scripts/phase6-browser-smoke.mjs`
- `src/app/(app)/notifications.tsx`
- `src/app/(app)/projects.tsx`
- `src/app/(app)/projects/[id].tsx`
- `src/app/(app)/projects/[id]/members.tsx`
- `src/app/(app)/projects/[id]/progress.tsx`
- `src/app/(app)/projects/[id]/tasks/[taskId].tsx`
- `src/app/(app)/projects/[id]/tasks/[taskId]/history.tsx`
- `src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx`
- `src/app/(app)/templates.tsx`
- `src/features/auth/AuthProvider.tsx`
- `src/features/auth/PermissionProvider.tsx`
- `src/features/auth/auth.ts`
- `src/features/notifications/notifications.ts`
- `src/features/projects/projects.ts`
- `src/lib/local-cache/bootstrap-models.ts`
- `src/lib/local-cache/bootstrap-pages.ts`
- `src/lib/local-cache/bootstrap-types.ts`
- `src/lib/local-cache/bootstrap.ts`
- `src/lib/local-cache/cache.ts`
- `src/lib/local-cache/driver.web.ts`
- `src/lib/local-cache/read-freshness.ts`
- `src/lib/local-cache/read-model-events.ts`
- `src/lib/local-cache/refresh-scheduler.ts`
- `src/lib/local-cache/repository.ts`
- `src/lib/local-cache/runtime-config.ts`
- `src/lib/local-cache/sync.ts`
- `src/lib/local-cache/use-read-model-updates.ts`
- `src/lib/supabase/realtime.ts`
- `tests/cache-first-regressions.test.ts`
- `tests/local-cache.test.ts`
- `tests/members-realtime-lifecycle.test.tsx`
- `tests/offline-auth-identity.test.ts`
- `tests/offline-auth-profile.test.tsx`
- `tests/offline-auth-startup.test.tsx`
- `tests/offline-bootstrap.test.ts`
- `tests/offline-phase6-runtime.test.ts`
- `tests/offline-repository-overlay.test.ts`
- `tests/offline-repository-races.test.ts`
- `tests/permission-provider-cache.test.tsx`
- `tests/read-refresh-scheduler.test.ts`
- `tests/realtime-permissions.test.ts`
