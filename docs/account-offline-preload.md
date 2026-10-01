# Account-wide offline preload — отчёт о реализации

Дата проверки: 1 октября 2026. Отчёт фиксирует реализацию и проверки перед Git-публикацией. Commit/push текущей ветки выполняются отдельно по последующему запросу пользователя; application/Supabase deploy в эту работу не входит.

## 1. Изменённые и добавленные файлы

Изменены 20 существующих файлов:

| Файл | Изменение |
| --- | --- |
| `package.json` | Команда `smoke:offline:browser`. |
| `scripts/run-sql-tests.mjs` | Новый bootstrap SQL suite в общем локальном прогоне. |
| `src/app/(app)/profile.tsx` | Web-раздел «Офлайн-режим» под «Оформление», существующие radio-компоненты. |
| `src/app/(app)/projects.tsx` | Отдельный индикатор готовности. |
| `src/app/(app)/notifications.tsx` | Ограниченный локальный набор, офлайн-пагинация, объяснение окна, online-only отметка прочтения. |
| `src/app/(app)/projects/[id]/tasks/[taskId]/history.tsx` | Объяснение сохранённого 90-дневного окна. |
| `src/app/(app)/projects/[id]/tasks/new.tsx` | Просмотр содержимого выбранного шаблона, включая offline. |
| `src/app/_layout.tsx` | Неблокирующий `OfflineBootstrapProvider`. |
| `src/features/auth/AuthProvider.tsx` | Собственный profile snapshot и обновление кеша после online profile mutation. |
| `src/features/auth/auth.ts` | Transport-only восстановление текущей identity из действующего persisted session. |
| `src/features/notifications/notifications.ts` | Offline read model без изменения online pagination. |
| `src/features/projects/projects.ts` | Чтение шаблонов, дневного audit и истории через кеш; owned projects из основных snapshots; удалён старый best-effort nested prefetch. |
| `src/lib/local-cache/cache.ts` | Ограниченная запись history, task/project access guards, управление сбросом блокировок. |
| `src/lib/local-cache/repository.ts` | Проверка блокировки родительского проекта перед локальным чтением checklist. |
| `src/lib/local-cache/types.ts` | Контракт атомарного cache batch с compare-and-swap guards. |
| `src/lib/local-cache/driver.ts` | Реализация batch API в test/fallback driver. |
| `src/lib/local-cache/driver.web.ts` | IndexedDB v5, атомарный cache batch/CAS. |
| `src/lib/local-cache/driver.native.ts` | Совместимый cache batch API; native schema не менялась. |
| `src/types/database.types.ts` | Типы двух новых RPC, сгенерированные из локальной БД. |
| `tests/offline-web-storage.test.ts` | Сохранность старых stores при upgrade и атомарность/CAS/user isolation. |

Добавлены 15 файлов:

| Файл | Назначение |
| --- | --- |
| `src/lib/local-cache/bootstrap-types.ts` | Metadata, dataset definitions, progress. |
| `src/lib/local-cache/bootstrap.ts` | Manifest, pagination, resume, verification, leases, переключение схем. |
| `src/lib/local-cache/bootstrap-models.ts` | Преобразование datasets в существующие UI read models. |
| `src/lib/local-cache/OfflineBootstrapProvider.tsx` | Login/reconnect/foreground/Realtime/TTL lifecycle. |
| `src/lib/local-cache/use-offline-bootstrap.ts` | User-scoped подписка, межвкладочное обновление статуса, UTC+3 rollover. |
| `src/lib/local-cache/day.ts` | Общая граница дня UTC+3. |
| `src/components/ui/offline-ready-indicator.tsx` | Готовность только на `/projects`. |
| `supabase/migrations/20261001162836_account_offline_bootstrap.sql` | Versioned read-only bootstrap RPC. |
| `supabase/tests/account_offline_bootstrap_test.sql` | RLS, pagination, границы dataset windows, revoke. |
| `tests/offline-bootstrap.test.ts` | Lifecycle, failures, resume, incremental refresh, permissions, реальные repositories. |
| `tests/offline-bootstrap-ui.test.tsx` | Profile placement/selection и независимость индикаторов. |
| `tests/offline-auth-identity.test.ts` | Transport-only identity fallback, запрет 403/expired fallback. |
| `tests/offline-auth-profile.test.tsx` | Регрессия позднего profile mutation response после смены аккаунта и обычное обновление собственного snapshot. |
| `scripts/account-offline-browser-smoke.mjs` | Production PWA browser smoke исключительно против local Supabase. |
| `docs/account-offline-preload.md` | Этот отчёт. |

## 2. Migration и RPC

Новая migration создана через Supabase CLI; старые migrations не редактировались. Public API:

- `get_offline_account_manifest(p_scheme)` — user/schema/day/window metadata, counts, dataset revisions и hashes страниц.
- `get_offline_account_page(p_dataset, p_revision, p_offset, p_limit)` — страницы до 500 строк. Fingerprint и page вычисляются из одного materialized MVCC snapshot; изменение revision отклоняет старую страницу с `40001`.

Private helpers: `offline_account_rows` и `offline_dataset_revision`. Новых таблиц, mutation endpoints, replication protocol или receipt readers нет. Функции `SECURITY INVOKER`, с пустым `search_path`, проверкой `auth.uid()` и grants только для authenticated. SELECT сохраняет RLS; templates/effective roles/last editors используют существующие RPC с их действующими permission contracts. Overrides дополнительно ограничены project owner/admin. SQL проверяет разрешённые и запрещённые роли, включая отсутствие данных после revoke.

## 3. IndexedDB schema

`tasktrace-local-cache`: версия **4 → 5**. Существующие `entries`, `pending_operations`, `sync_conflicts` и индексы сохраняются. Bootstrap metadata и staging batches добавляются в `entries`; destructive upgrade отсутствует. `CacheEntry.schema_version` остаётся 1, bootstrap schema — 1. Native SQLite остаётся на существующей версии 5; preload lifecycle запускается только на web.

## 4. Keys и read models

Все ключи физически namespaced `user_id:key`. Новые keys: `bootstrap:metadata`, `bootstrap:batch:<dataset>:<revision>:<offset>`, `profile:self`, `templates`, `template:<id>`, `template-items:<id>`, `daily-audit:<project>:<UTC+3-day ISO>`, `audit:<task>:90days`, `notifications:window`.

Bootstrap заполняет существующие `projects:active/archived`, `project:<id>`, `members:<project>`, `tasks:<project>`, `task:<id>`, `task-role:<task>`, разрешённые `task-overrides:<task>`, `assignees:<task>`, `items:<task>:all/active/archived`, `task-stats:<project>:active/archived`, `my-tasks:<user>`, `last-editors:<task>` и access-block keys. Отдельной redundant модели owned projects нет.

## 5. Точный состав Basic

12 обязательных datasets: `profile`, `projects`, `members`, `profiles`, `tasks`, `roles`, `overrides`, `assignees`, `items`, `templates`, `template_items`, `daily_audit`.

Это собственный profile; все доступные active/archived проекты, этапы и пункты; участники и связанные доступные profiles; effective role; overrides только при праве управления; исполнители; текущие comments; все доступные templates/items. Cards/statistics и owned projects выводятся из этих данных. Daily audit содержит только доступные `task_item` события текущего дня UTC+3. Обязательны также сохранённые PWA assets и активный Service Worker. Для пользователя без права читать overrides корректен пустой dataset.

`item_actions`, receipts, server auth/recovery и неиспользуемые таблицы не загружаются.

## 6. Точный состав Extended

Basic плюс `history`, `notifications`, `last_editors`. History — только RLS-доступный project audit за последние 90 дней. Notifications — все собственные unread и последние 100 read, ordered by created_at/id. Last editors — результат существующего `list_task_item_last_editors` для доступных этапов. Older history/notifications доступны online; offline UI явно объясняет ограничение.

## 7. Progress

Каждый обязательный dataset имеет вес 1; ещё по 1 имеют assets и итоговая verification. Complete dataset = 1, незавершённый dataset = acknowledged offset/count; пустой dataset засчитывается после его завершения. Процент — `floor(100 × completedUnits / totalUnits)`: 14 units Basic, 17 Extended. Последняя unit появляется только при `offline_ready=true`. Таймерного fake progress нет.

## 8. Offline readiness

Состояния: `not_started`, `running`, `updating`, `ready`, `partial`, `error`; отдельно хранятся `basic_ready`, `extended_ready`, `offline_ready`, timestamps, manifest/revisions/pages, offset/status каждого dataset, assets status, lease и error.

Готовность требует всех datasets выбранной схемы, полных сохранённых batches, сохранённых PWA assets, повторного server manifest с совпадающими revisions, атомарной записи UI models и read-back их наличия. Неполная страница, missing dataset/batch, write/quota error, missing assets или access error не дают готовности. Отказ первой записи отображается как user-scoped ошибка в памяти, поскольку сама metadata не может быть записана. Наступление нового дня UTC+3 снимает readiness до обновления daily dataset; индикатор обновляется на границе дня и без reload.

## 9. Resume и несколько вкладок

Страница и её acknowledged offset сохраняются одной IndexedDB transaction. После reload продолжается следующий offset; повреждённый/утраченный complete batch скачивается заново. Изменившаяся revision начинает dataset заново, но совпадающие 500-row page hashes позволяют переиспользовать сохранённые страницы. `40001` вызывает до трёх bounded restarts.

Используется существующий Web Lock `tasktrace-sync:<user>`, per-user single-flight и fallback CAS lease на 45 секунд. Закрытая вкладка освобождает Web Lock; expired lease может забрать другой runner. RPC имеют 20-секундный timeout. BroadcastChannel передаёт только идентификатор пользователя для перечитывания статуса. Outbox/conflicts не входят в cache batch transactions. Более новые confirmed item `sync_version` не откатываются preload-ом.

## 10. Обновление после initial bootstrap

Provider запускается после восстановления authenticated session, при reconnect, foreground, полученных private Realtime invalidations и каждые пять минут. Invalidation debounced на 400 ms. Проверяется manifest; неизменившиеся datasets не скачиваются, изменившиеся страницы переиспользуются по hashes. Периодическая проверка покрывает изменения, для которых текущая серверная Broadcast-схема не отправляет user event, включая templates/profiles. Старые staging revisions очищаются после успешной verification.

Полный authoritative список projects/tasks сразу блокирует fallback к исчезнувшим ресурсам, даже если следующий dataset не скачался. Загруженные пониженные effective roles применяются сразу; недоступные management overrides удаляются при проверке project roles. Известные 401/403 никогда не считаются transport failure. Bootstrap access error удаляет confirmed private read data, сохраняя отдельные pending operations/conflicts.

## 11. Basic → Extended

User-scoped настройка сохраняется, readiness считается относительно Extended, устаревший runner отменяется. Online сразу запускается background preload; неизменившиеся Basic batches переиспользуются. Без сети выбор сохраняется как partial и загрузка продолжается при reconnect. Весь интерфейс не блокируется.

## 12. Extended → Basic

Extended datasets перестают быть обязательными. Если Basic ранее прошёл verification и относится к текущему дню, готовность устанавливается сразу, включая переключение без сети. History/notifications/last editors безопасно остаются в кеше; их наличие не влияет на Basic readiness. Extended данные не скачиваются в Basic refresh.

## 13. Logout/account switch

Сохраняется существующая политика проекта: local sign-out очищает session/tokens и закрывает Realtime; user-scoped snapshots и pending operations физически остаются на устройстве. Без действующей session чтение через repositories не получает этот cache namespace. Provider отменяет предыдущий runner при смене пользователя/token; async hooks проверяют user/generation. Пользователь B получает собственную metadata/настройку и Basic по умолчанию, без read model пользователя A. Preload не уничтожает несинхронизированные операции при logout. Истёкшая offline session не заменяется cached identity. При ревью перед публикацией воспроизведена и исправлена гонка profile mutation: исходный user фиксируется до RPC, повторно проверяется вместе с id полученного profile, а поздний ответ не записывается в кеш/UI нового пользователя.

## 14. Offline mutations

Существующие completion, percentage и comment outbox/sync операции, ordered replay, conflict gate и protocol v2 сохранены; регрессионные unit/SQL/backend tests проходят. **В текущей сборке офлайн-запись не включена.** Build flags отсутствуют в `.env` и process environment, поэтому обе capabilities OFF; `.env.example` остаётся false/false.

Обнаружена реальная граница текущей архитектуры: remote runtime capabilities кешируются только в памяти на 60 секунд и после expiry/fetch failure закрываются. После offline reload либо длительного отсутствия сети новая local mutation блокируется. Включение build flags не обеспечивает требуемую надёжную offline запись; runtime kill switch не обходился и не переписывался в рамках preload. Linked remote config ранее проверен как enabled/enabled; его значения не менялись.

## 15. Online-only mutations

Сеть по-прежнему требуется для project/task/item structural CRUD, archive/delete/restore, members, roles/overrides, assignees, ownership transfer, template CRUD, profile mutations, notification mark-read и Auth/recovery. В форму создания этапа добавлено чтение template contents; submit остаётся обычным online RPC. Новых structural queues нет.

## 16. Добавленные тесты

14 bootstrap tests: Basic/default/composition, archives/read models, real Postgres timestamp normalization/UTC+3 rollover, missing dataset/incomplete page/assets/quota failures, first-write failure, reload resume на 1001 items, unchanged refresh и single changed page, expired/cross-tab lease, сохранность outbox/newer versions, Extended window/readiness/switching, access revoke/demotion и user isolation, существующие repositories/daily progress.

4 rendered UI tests проверяют размещение и выбор в profile, persisted scheme, независимость индикаторов и отсутствие readiness на остальных pages. 2 Auth identity tests проверяют действующую offline session и запрет expired/403 substitution; ещё 2 AuthProvider tests проверяют profile mutation при смене аккаунта и обычное обновление собственного snapshot. Storage regression проверяет v4→v5, атомарность CAS и сохранность pending. SQL fixture проверяет RLS/role inheritance/override denial, archives/templates/comments, daily window, 90-day history, 205 unread + 100 read и stale revision/revoke.

Production browser smoke проверил fresh login → automatic Basic → network OFF → прямые reload ещё не открытых маршрутов `/projects`, project, archived project/task/checklist, members, task/comments, обе daily progress pages, profile и templates. Проверены раскрытие template items, содержимое template в new-task form, archived checklist tab, Basic default, Extended persistence, history banner, offline notifications pagination, 120 unread + 100 read, Extended→Basic readiness offline. Индикатор отсутствует на остальных проверенных страницах. Browser errors в финальном прогоне отсутствовали.

## 17. Результаты запусков

| Команда/проверка | Результат |
| --- | --- |
| Baseline unit suite | 21 файл / 172 tests PASS. |
| Промежуточные unit/full suites | 179 tests PASS; targeted 29 tests PASS; затем 188 tests прошли, но новый Auth suite не загрузился из-за React Native Flow import — добавлен изолирующий mock. Последующие полные прогоны 190, 191 и 193 tests PASS. |
| `npm test`, итоговый прогон перед публикацией | DB connection policy, TypeScript, lint без ошибок/предупреждений; **25 файлов / 195 tests PASS**. Новый profile-race test сначала воспроизвёл ошибку, затем прошёл после исправления; ошибка TypeScript в renderer setup нового теста также исправлена до успешного полного прогона. |
| `npm run typecheck`, `npm run lint`, отдельные прогоны перед публикацией | Оба PASS, lint без ошибок/предупреждений. |
| `npx expo export --platform all`, перед публикацией | Android/iOS/web export PASS; это проверка bundles, не device acceptance. |
| `npm run test:sql` | Local reset/apply migrations и **все 11 SQL suites PASS**. Ошибки первых локальных test fixtures (enum/dedupe/read_at constraints) исправлены до общего успешного прогона. |
| `npm run test:backend` | Data API/Auth/Realtime, web/native PKCE и двухсессионная concurrency — PASS. |
| `npm run gen:types` против local DB | Типы успешно сгенерированы, новые RPC присутствуют. |
| `npx --yes supabase@2.116.0 db advisors --local --type security --level warn --fail-on error` | No issues detected. |
| `npm run smoke:offline:browser` | Финальный полный сценарий PASS. Промежуточные прогоны выявили Windows daemon stdout timeout, несовпадение `+00:00`/`.000Z` в daily key и offline Basic-switch timeout; причины исправлены и покрыты тестами. |
| Production builds внутри smoke | Успешны; local URL/anon key и flags OFF задавались только через process environment, `.env` не редактировался. |
| `npm run build:web`, итоговая обычная сборка | PASS: 35 static routes, 6 precached files, 2 101 914 bytes. Финальный export и Workbox generation завершились штатно с exit code 0. Один из промежуточных exports напечатал сообщение Expo о forceful exit после export, также с exit code 0 и успешным Workbox generation. |
| `git diff --check` | PASS; Git сообщает только существующую Windows LF→CRLF conversion policy. |
| Linked read-only schema check | Новые public RPC отсутствуют, новая migration не применена. |

## 18. Известные ограничения и состояние поставки

- Новый bootstrap требует применения новой migration в целевой БД отдельным разрешённым deployment. Текущий linked Supabase не содержит этих RPC; обычная сборка с linked `.env` не сможет завершить account bootstrap до применения migration.
- Offline чтение требует ранее подготовленного snapshot, доступного IndexedDB/Service Worker и действующей persisted session. Новый день требует обновления daily audit online; прошлый день не выдаётся за сегодняшний. Browser eviction/quota может потребовать повторной подготовки.
- Hash manifest/page validation сканирует разрешённый dataset на сервере; network refresh передаёт только изменённые batches, но это не O(1) server cursor protocol. Производительность на аккаунтах с сотнями тысяч rows не измерялась. Resume/incremental batches проверены в unit tests на 1001 items.
- Snapshot не закрепляется отдельной durable server transaction между HTTP requests. При постоянных изменениях обязательных datasets verification может перезапускаться и оставлять статус partial до успешного стабильного прохода; неподтверждённый набор не объявляется готовым.
- Проверен Chromium через production PWA. Safari/Firefox, реальные mobile devices, физическая двухвкладочная browser acceptance и сценарий PWA-update с уже работающим старым клиентом отдельно не проходились. Два независимых runner-а/CAS проверены unit tests; существующие PWA navigation и update implementation сохранены.
- Надёжная offline запись после reload/60-секундного expiry остаётся описанной runtime-config границей; флаги не включены.

**Linked Supabase:** только read-only проверки, без DDL/DML/deploy/history repair. **Реально применено:** новая `20261001162836_account_offline_bootstrap.sql` только к local Supabase; общий SQL runner также переустановил предыдущие migrations в local test stack. **Flags:** ни build flags, ни remote runtime values не изменены. **Git перед commit:** 20 modified tracked + 15 новых файлов текущей фазы, посторонних изменений не обнаружено. Commit/push выполняются одним conventional commit по последующему запросу пользователя; deploy не выполняется. `.env`, реальные credentials, builds, логи и screenshots исключены из Git-публикации.

Локальный browser fixture удаляет созданные project/template данные через существующий lifecycle. Синтетическая local Auth identity/audit сохраняется из-за действующих immutable history/profile FK constraints; ограничения удаления не обходились.
