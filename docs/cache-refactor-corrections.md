# Исправления cache/storage после 122f0ec

Дата: 2026-10-08. База: `122f0ecf2f52036f315d904e4cea3fe6dce697b5`.

## Причины и исправления

| Пункт | Root cause | Изменение и файлы |
| --- | --- | --- |
| Account switch / Realtime | AuthProvider публиковал новый read account до отложенного закрытия каналов; канал определял владельца через текущий аккаунт при доставке события. | `AuthProvider.tsx` закрывает каналы синхронно перед новым namespace. `realtime.ts` фиксирует userId/account epoch канала и subscription effect, проверяет их при event/status/reconnect. Поздний callback A не вызывает listeners и не пишет invalidation B. |
| Legacy storage | Перенос certified batches и удаление физического `items:*:all` выполнялись только при preparation. | Новый `cache-format-migration.ts`, вызванный из `getBootstrapMetadata` после проверки фактического Basic readiness. Certified legacy pages копируются без HTTP. Новые pages, certificate references и удаления переключаются одним atomic CAS commit. `all` удаляется только при валидных active/archived partitions, покрывающих все его items и версии. |
| Badge notifications | `fetchUnreadCount` выбирал общий window loader при существующем window. Stale window скачивал notification rows. | `notifications.ts` всегда revalidates отдельный `notifications:unread-count` через HEAD/count. Полный window обслуживает список. Offline fallback поддерживает старый Extended window без count model и проходит ACL/account fences. Mutations и Realtime инвалидируют обе модели; coalesced commit subscriptions сохранены. |
| Global ACL cost | Глобальный ACL сигнал перечислял модели и создавал marker для каждой. | `read-freshness.ts` сохраняет один `read:acl:epoch`. Volatile fence действует сразу; durable token сохраняется после reload. `cache.ts` и `bootstrap.ts` подтверждают только проверенные модели, атомарно с их данными и CAS guard по global token. Новый token не позволяет позднему ответу или старому bootstrap снять quarantine. |

`cache.ts` также повторно проверяет актуальную freshness после storage I/O: marker, уже снятый соседним refresh, не запускает второй запрос. Виртуальный `all` наследует подтверждения обеих canonical partitions; не добавляет materialized rows или лишнюю загрузку.

## Безопасность миграции

Миграция не меняет `OFFLINE_BOOTSTRAP_VERSION` или schema IndexedDB/SQLite. Она выполняется при проверенном readiness и отсутствии активной preparation/lease; истёкшая lease после crash не препятствует безопасному переносу. Проверяет источник через certificate checksum, dataset hash/размер страницы и структуру partitions; не заменяет конфликтующую immutable page. Если canonical partitions ещё недостаточны, сохраняется чтение прежнего физического `all` до безопасного переноса.

Commit guards включают certificate inputs/models, metadata, global ACL token и отсутствие создаваемых страниц/markers. Изменение модели, схемы подготовки, другого certificate или ACL отменяет всю транзакцию. CAS loser перечитывает опубликованный certificate и проверяет readiness заново. Timeout/abort прерывает operation-scoped transaction; прерывание до commit оставляет прежний snapshot целым.

Удаления ограничены доказанно избыточными `items:*:all` и перенесёнными legacy batches, на которые больше не ссылаются retained certificates. Pending operations, conflicts, outbox, receipts, cursor и runtime config не удаляются. Namespace другого пользователя не затрагивается.

## Новые регрессии

- `cache-realtime-account.test.tsx`: SDK switch A → B и A → logout до deferred React apply; late event не создаёт volatile/durable invalidation B; закрытие происходит ещё в namespace A; A → B → A epoch fence; TOKEN_REFRESHED сохраняет freshness и канал.
- `notification-count-cache.test.ts`: stale window + badge делает только HEAD/count; Notifications получает rows; mark/read-all обновляют badge; burst Realtime/Broadcast commits делает один HEAD без row downloads/loop; offline legacy window; ACL denial и поздняя pagination response.
- `cache-first-regressions.test.ts`: глобальный ACL на 101 cached models выполняет ровно один физический IndexedDB put и не перечисляет модели; подтверждение одного model не снимает quarantine остальных; reload, account isolation, soft invalidation; cross-tab signal во время HTTP/перед CAS; виртуальный all без HTTP/физического all; volatile ACL во время final durable read.
- `offline-bootstrap.test.ts`: ready Basic upgrade offline, sufficient partitions, idempotence, protected sync records и другой namespace; missing/incomplete/corrupt cache и live lease; interruption; certificate без checksums; competing cleanup и CAS loser; cross-tab ACL во время migration/final manifest verification.

Всего добавлено 30 test cases. Прежняя ACL bootstrap регрессия проверяет снятый quarantine и новое acknowledgement вместо удаления marker. Дополнительно проверены expired lease после crash и чтение прежнего `all` при недостаточных canonical partitions.

## Проверки

- `npm test`: финальный прогон DB connection policy, `npm run typecheck`, `npm run lint` и **47 файлов / 493 теста PASS**.
- `npm run test:backend`: local Data API/Auth/Realtime, web/native GoTrue PKCE, two-session concurrency, bootstrap HTTP — PASS. 15 datasets × 10 rounds; controlled mutation PT409 → свежий snapshot HTTP 200.
- `node scripts/run-audit-sql-tests.mjs`: isolated legacy upgrade, 13 SQL suites и 3 concurrency regressions — PASS. Общий development DB не сбрасывался.
- `npx --yes supabase@2.116.0 db advisors --local --type security --level warn --fail-on error` — PASS, замечаний нет.
- Web/PWA build и полный `node scripts/account-offline-browser-smoke.mjs` — PASS: direct offline reload/navigation, три online/offline cycles, Retry/deadline/coalescing, focus/visibility/tabs, 45 секунд idle без HTTP и адресное восстановление missing page, desktop/390px layout, durable offline checkbox/percentage/comment и receipts, cross-tab disable, Extended interruption 94% → recovery и Extended → Basic, bounded notifications/history.
- Полный `node scripts/phase6-browser-smoke.mjs` — PASS: local-first edits, offline/F5/reconnect, conflicts и server resolution, remote capability kill, multitab single receipt, service-worker update с pending operation, revoke/restore и явный retry после F5.
- Финальный `npx expo export --platform all --output-dir .expo/cache-fix-complete-export` — PASS для Android/iOS/Web, 35 статических web routes.

- Финальная local Web/PWA сборка (`scripts/build-phase6-local-smoke.mjs`) — PASS. `node scripts/offline-navigation-browser-smoke.mjs` на этой сборке — PASS: восемь offline routes по 86–252 мс, без HTTP; expired saved session — 118/125 мс без HTTP; переходы project/task при transport failure — 42/32 мс без HTTP; online recovery восстанавливает Data API reads.

Оба полных browser smoke выполнены до двух заключительных защитных поправок для legacy cache (истёкшая lease и недостаточные canonical partitions). Эти поправки покрыты новыми регрессиями в финальном `npm test`; после них выполнены финальные export и navigation/performance smoke. Первый запуск `npm run smoke:offline:performance`, параллельный native export, упал только на timing threshold task progress: 2581 мс при лимите 1000 мс, без HTTP. Отдельный повтор на той же финальной Web-сборке полностью прошёл, task progress — 105 мс; причина первого выброса достоверно не установлена. Лимит теста и код ради этого результата не менялись.

## Состав изменений

Production:

- `src/features/auth/AuthProvider.tsx`
- `src/features/notifications/notifications.ts`
- `src/lib/supabase/realtime.ts`
- `src/lib/local-cache/cache.ts`
- `src/lib/local-cache/read-freshness.ts`
- `src/lib/local-cache/bootstrap.ts`
- `src/lib/local-cache/cache-format-migration.ts` (новый)

Регрессии: `tests/cache-realtime-account.test.tsx` и `tests/notification-count-cache.test.ts` (новые), `tests/cache-first-regressions.test.ts` и `tests/offline-bootstrap.test.ts` (дополнены). Отчёт: `docs/cache-refactor-corrections.md` (новый). Всего 12 файлов, посторонних изменений нет.

## Сохранённые инварианты и ограничения

Сохранены cache-first/SWR, TTL 60 секунд, single-flight, scoped data invalidation, content-addressed immutable pages, отсутствие новых materialized `items:*:all`, один runtime coordinator, Basic/Extended, automatic connectivity, transport-only fallback и authoritative RLS/RPC перед replay. Revoke блокирует cache немедленно; ни marker, ни Broadcast payload не предоставляют серверные права доступа.

Все четыре пункта реализованы. Безопасно непереносимые legacy batches (например, certificate без per-page checksum) остаются доступными в прежнем формате до обычной verified preparation. Неполный/повреждённый cache и активная preparation не очищаются. Это сохраняет snapshot, а не выдаёт неподтверждённый content hash.

SQL/API/RPC signatures, зависимости, hosted production и production flags не менялись. Physical Android/iOS device smoke и hosted production validation не выполнялись. Commit/push для этих исправлений не выполняются без отдельной команды.

Проверенные SDK conventions: [HEAD/count](https://supabase.com/docs/reference/javascript/select), [Auth lifecycle](https://supabase.com/docs/reference/javascript/auth-onauthstatechange). Внешний API не расширялся.
