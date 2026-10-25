# TaskTrace: устранение блокеров F01–F09

Дата: 25.10.2026, Europe/Simferopol. Режим: IMPLEMENTATION + TESTING + REGRESSION FIXING, без Goal.

**Итог: COMPLETE WITH CONDITIONS. Проект подготовлен к повторному независимому аудиту; production READY не объявляется.** Подтверждённые F01/F02/F05 устранены в реализации и проверенных сценариях. F06 требует отдельного решения владельца по security; F07 — подтверждения удалённого release hold. Эти условия не выдаются за выполненные действия.

Предыдущий аудит и все его evidence сохранены в `C:/Users/chupa/AppData/Local/Temp/tasktrace-final-audit-20261024`. Его вердикт не переписывался. Накопленные B01–B07, P02–P05, R01–R03 сохранены и повторно проверены. Production использовался только для read-only каталогов/определений; все изменяющие SQL и HTTP проверки выполнялись на изолированных тестовых БД.

## 1. Сводка F01–F09

| ID | Первопричина | Конкретное изменение | Результат / evidence |
|---|---|---|---|
| F01 | Ненужный bump IDB до 6; старый parser мог трактовать v3 envelope как legacy UUID | Web сохраняет schema v5, читает существующий v6 без удаления/downgrade; отдельный ключ `sync:mutation:v3:`; атомарный перенос существующего envelope; новые v3 attempts/rebase используют UUIDv8; legacy claim отвергает их даже после GC. SQLite v6/полные handles сохранены; отдельный совместимый rollback export | 3 исходные отрицательные unit-регрессии воспроизвели ошибку до исправления; после — PASS. Реальные Chromium/WebKit со старым SW JavaScript, v2/v3 непустой очередью, закрытием вкладки во время upgrade и restart; SQLite contract; HTTP namespace fence до/после GC |
| F02 | Независимая форма принимала observed unknown/running за свой retry | Чужой envelope больше не определяет identity новой формы. Feature callers объявляют new; та же открытая форма профиля и review UI явно объявляют retry. Новая форма не получает старый success; точный настоящий retry сохраняет ID/full handle | Реальные две вкладки и PostgREST: после lost ACK независимое одинаковое действие получает reconciliation notice; последующее явное действие имеет другой ID и второй эффект. 400 повторов recovery; unit и реальные UI сценарии quota/lost ACK |
| F03 | Один пользователь за batch; число пользователей ограничивало cron независимо от p_batch | Ограниченный набор строк нескольких аккаунтов; global budget lock до отсортированных user locks; DELETE по materialized CTID candidates; атомарный grouped accounting; round-robin `gc_touched_at` между eligible epochs; максимум 8 эпох и cooperative time budget, cron timeout 20 s | 100/1000/10000 аккаунтов; 200000 receipts; 12 эпох; два worker; rollback/accounting/crash; реальные cron worker и четыре ускоренных дня |
| F04 | Две NULL policy и отдельные commits создавали неподготовленный переход | Серверный maintenance preflight **до** шести миграций; общий write/admission fence; атомарный helper обеих policy; открытие запрещено при неполной настройке. Утверждённые cutoffs вводит оператор | Настоящий PostgREST подтверждает отказ без эффекта после каждого migration step, атомарный rollback невалидного config и успешный old/v3 после согласованного открытия. Postconditions выполнены read-only в cron fixture |
| F05 | JWT-проверка не учитывала deleted Auth account; direct mutation paths жили вне cutover | Авторитетный `require_auth` проверяет существующий active Auth account. 52 business mutation signatures инвентаризированы и guarded. Direct legacy business admission закрывается после cutoff/irreversible fence; v3 использует тот же dispatch/ACL | Отказ на всех 52 сигнатурах для deleted account и отсутствие эффекта; действительные операции проходят; direct путь после cutover закрыт, v3 работает. Security matrix 57 RPC ×610 сценариев в fresh и upgrade |
| F06 | 5 HIGH / два корневых advisory; старое исключение не соответствует графу | Совместимый upstream fix не найден. Непроверенный major override не применён. Raw FAIL и gate FAIL сохранены; подготовлено конкретное неутверждённое предложение с hashes/metadata | Свежие npm audit/gate, registry/advisory, три platform source maps, Doctor. См. `docs/release/security-proposal.md` и `.json` |
| F07 | Push мог публиковать при красном CI | Локальный Vercel Git autodeploy выключен; host build требует exact approved SHA и успешный acceptance artifact/manifest; подготовлен hold/promotion plan для обоих providers | Unit отрицательные проверки hold, actionlint и workflow validator PASS. Timeweb hook остаётся active; Vercel settings read —403. Удалённый hold должен подтвердить владелец **до push** |
| F08 | 83 local /77 hosted не означали готовность общего db push | Manifest ровно шести SQL с order/version/name/hashes/dependencies; hashes 78 исторических файлов; raw production catalog preconditions; отдельная проверка совместимости fixture с фактическими SQL tokens/ACL/RLS/constraints | 154 function token contracts; 21 table/view, 138 columns, 10 policies, 78 constraints, 43 triggers, 60 indexes. 18 historical local-only /17 remote-only /19 name mismatches сохранены; история не менялась |
| F09 | Новые acceptance scripts не были обязательными | Отдельный workflow с static Node22/24, database и security; итоговый `release-acceptance-decision` fail-closed при failure/skipped/cancelled. Все нужные HTTP/browser/storage/GC/crash проверки включены | Actionlint 1.7.12 и структурная проверка PASS; exact checkout SHA и hashes проверяются до выдачи decision. Remote workflow ещё не запускался, поскольку commit/push запрещены |

## 2. Совместимость и сохранность данных

Новый Web-код не требует изменения object stores/indexes: v3 поля допустимы в существующих записях IDB v5. Старый SW-клиент и новая вкладка проверены совместно. Для уже существующего pre-release v6 используется opener без понижения версии; исходный старый v5 JS в таком хранилище остаётся несовместимым. Его нельзя выдавать как безопасный rollback.

Ключ v3 невидим старому online parser. Перенос envelope выполняется одним conditional cache batch, сохраняя UUID, args, phase и handle. В SQLite новые columns остаются на месте даже после старого UPDATE, помечающего неподдерживаемую v3 запись failed. Контракт reopen/сохранности opaque handle проверен на настоящем SQLite Node-драйвере; это не физический native/OTA тест.

UUIDv8 является постоянным namespace discriminator для новых v3 attempts. Он не заменяет generation/epoch/full handle. Existing legacy/v2 IDs не переписываются; известные исторические legacy UUIDv8 тоже могут повторяться как прежняя legacy-квитанция. Для сохраняемых pre-release v3 UUIDv4 сервер запрещает legacy применение, пока квитанция существует; release initialization требует закрыть legacy admission не позже её GC eligibility. На наблюдаемом production v3 ещё отсутствует.

Поддерживаемый rollback — отдельный **v3-compatible** JS/export artifact из текущей реализации, включая Web SW, SQLite/IDB contracts и namespace fence. Builder и manifest находятся в `scripts/build-compatible-rollback.mjs` и `.expo/compatible-rollback/rollback-manifest.json`. Локальная сборка с `ci.invalid` помечена verification-only; для реального выпуска нужны утверждённая public config и отдельная платформенная приёмка. Старый HEAD и старые native binaries не одобрены для rollback после v3.

Ни очереди, ни БД ради совместимости не очищались. Привязанные неизвестные попытки не получают новый namespace автоматически. Настоящие retry, quota refusal, reload, tab close и orphan recovery сохраняют full handle; отдельная новая форма не закрывается старым success.

## 3. GC: измерения и пределы

Изолированный PostgreSQL **17.11**, реальные SQL удаления и accounting, p_batch=500:

Масштабные fixtures наполнялись прямым SQL: маленький outcome и accounted_bytes=327 на строку. Это не 200000 HTTP claims и не представительное распределение размеров payload. Реальные admission/replay измерялись отдельным PostgREST-набором.

| Аккаунты | Receipts/аккаунт | Всего | Полных ticks до удаления descriptor | Время очистки в текущей лаборатории |
|---:|---:|---:|---:|---:|
| 100 | 1 | 100 | 2 | около 10 ms |
| 1000 | 1 | 1000 | 3 | около 22 ms |
| 10000 | 1 | 10000 | 21 | около 185 ms |
| 10000 | 20 | 200000 | 401 | около 2,68 s |

Пиковый tick плотного сценария — около 17,2 ms в сохранённом прогоне. Это tight loop на локальном сервере, а не ожидание пяти минут между ticks. Все global/user count/bytes сверялись с реальными строками. 12 eligible epochs обслужены за два ticks; конкурентные workers не дали deadlock/accounting drift.

В модели **4 ускоренных суток**, каждый день добавлялись 200000 expired receipts (10000×20), выполнялись 288 реальных SQL ticks. Остаток: **56000,56000,56000,56000**. Показана устойчивость cleanup под этим профилем при ускоренном расписании; одновременная реальная business-нагрузка, network и production hardware в этот тест не входят.

Исходный новый set-based вариант выявил плохой DELETE plan на 200000 строках. Он исправлен materialized CTID candidates, после чего плотный сценарий прошёл. Увеличение timeout для сокрытия проблемы не применялось.

Отдельно реальный pg_cron worker удалил квитанции 100 аккаунтов, сохранил budgets и вернулся к расписанию */5. Проверена исходная команда с внешним statement_timeout=20s. Пройден read-only postconditions artifact. Это отдельная проверка нового lifecycle, а не только старого deadline job.

Admission/replay benchmark: 512 operations, 8 пользователей, concurrency16; подробные latency/storage/WAL — `.expo/release-acceptance/v3-load.log`. Новый namespace index увеличивает physical storage. После DELETE heap не обязан уменьшаться. Лабораторные числа не являются production SLA, pricing или доказательством полной масштабируемости приложения до 10000 DAU.

## 4. Фактические проверки

Основные логи: `.expo/release-acceptance/`. Предыдущие неудачные диагностические запуски не переименовывались в PASS; при повторных acceptance runs logger сохраняет прежние логи в `attempts/`. Финальный комплект результатов — `results-all.json`, отдельные schema/cron results и scope/status artifacts.

| Проверка | Результат |
|---|---|
| TypeScript; expo lint --no-cache; DB connection policy | PASS |
| Unit Node22.20.0 и Node24.15.0 | **931/931**, 79 файлов, в каждом прогоне |
| SQL fresh /upgrade | 19 /22 набора; **84 миграции** только в изолированных БД |
| Supabase pinned security advisor | 0 SECURITY ERROR; WARN/INFO не скрыты |
| V3 PostgREST | 30 fresh +30 upgrade PASS |
| B/P HTTP | 11 fresh +11 upgrade PASS |
| Security matrix | 57 RPC /610 сценариев в каждом режиме, PASS |
| F01–F05 targeted HTTP/SQL | PASS, в том числе все 52 inventoried mutation signatures |
| Cross-tab Chromium и WebKit | В каждом 100 lost-ACK +100 running-orphan closures, PASS; отдельный F02 independent identical after unknown PASS |
| Real browser storage/SW compatibility | Chromium/WebKit PASS |
| Native SQLite contracts | PASS; устройство/бинарник не подменяются Node SQLite |
| UI | 4 R01 browser scenarios +9 B/P групп PASS |
| GC scale/fairness/concurrency/accelerated sustained profile | PASS с указанными ограничениями |
| Crash before/after commit +fenced restore | 3 PASS на собственном одноразовом сервере; crash image взят от локального provider (17.6), основной acceptance сервер17.11 |
| Реальные deadline/lifecycle pg_cron; release postconditions | PASS |
| PWA fallback/boundaries/update | Chromium/WebKit PASS |
| Web/Android/iOS exports; separate compatible rollback | PASS локальных exports; synthetic public config |
| Bundle exposure | node-forge/zod/braces отсутствуют в трёх platform source maps; hashes сохранены |
| npm audit /security gate | **FAIL /FAIL**; 5 HIGH, отдельное исключение не утверждено |
| Expo Doctor | 21/21 PASS |
| CI workflow checks | actionlint1.7.12 +структурный validator PASS; GitHub execution не выполнялось |

Регрессии, найденные и исправленные в ходе работы: исходные три F01/F02 negative unit; новое плотное GC удаление; новые требования active Auth fixtures; явный retry профиля после quota/lost ACK; отображение авторитетного member denial при reconciliation. Assertions не отключались. Старые проверки версии Web6 изменены на обязательную Web5 совместимость; проверка нового UUID требует именно version8, а не ослабленный формат. Первый полный unit run прерывался после каскада не закрытого тестового IDB connection; finally-close и корректный ожидаемый schema version устранены, полные Node22/24 прогоны прошли.

## 5. Migration manifest и фактическая схема

Новая forward migration этой фазы — **20261024142519_release_blocker_guards.sql**, создана Supabase CLI. Ни один из 83 прежних migration files, включая пять ранее подготовленных, не переписывался. Всего локальных SQL теперь84; разрешённый будущий release manifest включает только пять предыдущих новых плюс одну новую, в точном порядке.

Файлы: `docs/release/manifest.json`, `preflight.sql`, `production-preconditions-2026-10-24.json`, `prepare-maintenance.sql`, `postconditions.sql`. Baseline каталога исходного аудита обновлён повторным read-only снимком для детальной проверки; история production по-прежнему77 записей. Файл с датой24.10 сохраняет связь с исходным аудитом, проверен повторно в текущей фазе.

Raw production preflight сравнивает **всё точно** и останавливается при любом drift. Только изолированное сравнение исторического fixture допускает 12 конкретных зафиксированных metadata pairs; unknown pairs запрещены. Функции сравниваются по проверенным SQL tokens, сохраняя строковые литералы, аргументы/defaults, called functions, owner/config/ACL. 10 текстовых вариантов просмотрены отдельно; форматирование/EOL и optional final semicolon не меняют SQL. Проверены и отрицательные случаи fingerprint. Расхождение полномочий касается двух существующих invoker trigger-only helpers; PostgreSQL подтвердил, что обычный SQL/RPC вызов невозможен даже владельцу. Runtime grants/RLS этим сравнением не ослаблялись.

## 6. Условия выпуска и оставшиеся ограничения

Полный порядок, зависимости, stop criteria и recovery: **docs/release/runbook.md**. Оба набора policy конфигурируются атомарно под server maintenance. Произвольные production cutoffs не назначались. Положительные canary после контролируемого открытия требуют отдельного разрешения владельца.

До выпуска остаются: отдельное решение F06; подтверждённые Vercel/Timeweb remote holds/commands/branch controls; реально обязательный `release-acceptance-decision` в GitHub protection; backup/PITR и внешний restore fence; production sizing и approved timestamps; реальные Android/iOS/OTA/rollback проверки. Доступ к Vercel scope ограничен403. Timeweb hook active; его приложение и branch filters не выдумывались. Ни один из этих пунктов не отмечен выполненным.

Физические устройства, hosted write smoke, production restore и долгий реальный soak не выполнялись. Историческая первопричина самого первого R03 эпизода не установлена задним числом. Полная потеря всех локальных handles и невозвратное удаление серверной истории по-прежнему требуют явной сверки, а не автоматического нового ID.

## 7. Git и неизменность production

<!-- FINAL-GIT:START -->
HEAD до/после: **810f1a367b7d350b5e3ce1bb0b62f22093ba9049**. Исходно51 modified +23 untracked +0 staged. Сейчас **57 modified /51 untracked /0 staged** (полный список ниже).

Сохранены все 466 исходных файлов; удалённых0. Все 83 прежних migration files побайтово совпадают с baseline. Текущая фаза изменила 24 исходных файлов и добавила 28 путей поверх прежних74 dirty files. Package/lock и действующая security policy этой фазой не менялись. Index SHA-256: cf48b7a25e1ed5bee723af7a9548c670e3b12920ed20812e8e2b647dbb11c788; совпадение с baseline: true.

Машинный контроль: .expo/release-acceptance/phase-scope.json; результаты18 backend acceptance suites: backend-final.json.

```text
 M package-lock.json
 M package.json
 M scripts/checklist-deadline-cron.mjs
 M scripts/connectivity-recovery-browser-smoke.mjs
 M scripts/generate-service-worker.mjs
 M scripts/pwa-mobile-browser-smoke.mjs
 M scripts/regression-mutation-browser.mjs
 M scripts/run-audit-sql-tests.mjs
 M scripts/security-receipt-races.mjs
 M scripts/security-test-harness.mjs
 M scripts/test-security-hardening.mjs
 M src/app/(app)/notifications.tsx
 M src/app/(app)/profile.tsx
 M src/app/(app)/projects/[id].tsx
 M src/app/(app)/projects/[id]/progress.tsx
 M src/app/(app)/projects/[id]/tasks/[taskId].tsx
 M src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx
 M src/app/(app)/templates.tsx
 M src/app/(auth)/_layout.tsx
 M src/components/ui/realtime-indicator.tsx
 M src/features/auth/AuthProvider.tsx
 M src/features/auth/auth.ts
 M src/features/notifications/notifications.ts
 M src/features/projects/projects.ts
 M src/lib/errors/user-message.ts
 M src/lib/local-cache/driver.native.ts
 M src/lib/local-cache/driver.ts
 M src/lib/local-cache/driver.web.ts
 M src/lib/local-cache/failed-chain.ts
 M src/lib/local-cache/outbox.ts
 M src/lib/local-cache/refresh-scheduler.ts
 M src/lib/local-cache/repository.ts
 M src/lib/local-cache/runtime-config.ts
 M src/lib/local-cache/runtime-state.ts
 M src/lib/local-cache/status.ts
 M src/lib/local-cache/sync.ts
 M src/lib/local-cache/types.ts
 M src/lib/local-cache/use-sync-indicator.ts
 M src/lib/supabase/mutation.ts
 M src/types/database.types.ts
 M supabase/tests/offline_phase6_runtime_retention_test.sql
 M tests/mutation-contexts.test.ts
 M tests/notification-count-cache.test.ts
 M tests/offline-auth-profile.test.tsx
 M tests/offline-bootstrap.test.ts
 M tests/offline-native-storage.test.ts
 M tests/offline-outbox.test.ts
 M tests/offline-phase6-runtime.test.ts
 M tests/offline-repository-races.test.ts
 M tests/offline-sync.test.ts
 M tests/offline-web-storage.test.ts
 M tests/online-mutation.test.ts
 M tests/read-refresh-scheduler.test.ts
 M tests/security-policy-gate.test.mjs
 M tests/sync-ux.test.tsx
 M tests/tasktrace-regressions.test.ts
 M vercel.json
?? .github/workflows/release-acceptance.yml
?? docs/audit-fixes-2026-10-22.md
?? docs/client-operation-protocol-v3.md
?? docs/operation-window-implementation-2026-10-23.md
?? docs/release-blockers-implementation-2026-10-25.md
?? docs/release/fixture-differences.json
?? docs/release/function-token-contract.json
?? docs/release/manifest.json
?? docs/release/postconditions.sql
?? docs/release/preflight.sql
?? docs/release/prepare-maintenance.sql
?? docs/release/production-preconditions-2026-10-24.json
?? docs/release/runbook.md
?? docs/release/security-proposal.json
?? docs/release/security-proposal.md
?? scripts/audit-fixes-browser.mjs
?? scripts/audit-fixes-integration.mjs
?? scripts/build-compatible-rollback.mjs
?? scripts/check-release-workflows.mjs
?? scripts/operation-window-crash.mjs
?? scripts/operation-window-integration.mjs
?? scripts/operation-window-load.mjs
?? scripts/operation-window-ui-browser.mjs
?? scripts/receipt-test-policy.mjs
?? scripts/release-blockers-integration.mjs
?? scripts/release-bundle-exposure.mjs
?? scripts/release-decision.mjs
?? scripts/release-gc-scale.mjs
?? scripts/release-host-build.mjs
?? scripts/release-manifest.mjs
?? scripts/release-preflight.mjs
?? scripts/release-schema-compatibility.mjs
?? scripts/release-sql-fingerprint.mjs
?? scripts/release-storage-browser.mjs
?? scripts/run-release-acceptance.mjs
?? src/features/projects/daily-progress-row.tsx
?? src/lib/local-cache/operation-attempt.ts
?? src/lib/supabase/operation-handle.ts
?? supabase/migrations/20261022201114_audit_task_snapshot_revision.sql
?? supabase/migrations/20261022201149_audit_rpc_outcomes.sql
?? supabase/migrations/20261022202128_audit_receipt_budgets.sql
?? supabase/migrations/20261023115036_operation_window_protocol.sql
?? supabase/migrations/20261023115657_operation_window_lifecycle.sql
?? supabase/migrations/20261024142519_release_blocker_guards.sql
?? supabase/tests/audit_fixes_test.sql
?? supabase/tests/operation_window_test.sql
?? tests/checklist-snapshot-reader.test.ts
?? tests/notification-bulk-retry.test.tsx
?? tests/operation-window-storage-contract.ts
?? tests/release-blockers.test.ts
?? tests/release-tools.test.mjs
```
<!-- FINAL-GIT:END -->

Commit, push, deploy, production migrations и изменение удалённых hosting settings не выполнялись. Все нужные исправления и тесты подготовлены локально; исправления не опубликованы. Единственные обращения к production SQL — read-only каталоги/определения, без DDL/DML. Пользовательская рабочая БД не сбрасывалась, не мигрировалась и не рестартовалась. Собственные тестовые контейнеры завершены, существующий Supabase stack сохранён.

**Финальный вердикт: COMPLETE WITH CONDITIONS для локальной реализации и повторного аудита; production release остаётся HOLD.**
