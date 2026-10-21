# Исправление регрессий TaskTrace — 21.10.2026

**Общий результат: FAIL по готовности к выпуску.** Из пяти находок исправлены **4**, осталась **1 проблема / 1 блокер: DEPLOY-01**. REG-01, REG-02 и REG-03 исправлены в рабочем дереве и проверены. SECURITY-01 имеет воспроизводимый контролируемый результат. Production не готов к выпуску до обеспечения порядка сервер → клиент.

**Commit: NOT PERFORMED. Push: NOT PERFORMED.** Условие пользователя для доставки не выполнено. Production-схема и deployment settings не изменялись.

## Статусы пяти находок

| ID | Статус | Первопричина | Исправление | Доказательство |
| --- | --- | --- | --- | --- |
| REG-01 HIGH | PASS в проверенной области | Retry определял UUID после Web Lock; другой контекст успевал удалить envelope. Дополнительно истечение ожидания и внезапное закрытие могли лишать вкладку связи с операцией | Захват ID до lock; handle вкладки переживает reload/timeout; running проверяется по живому lock; атомарные claim/remove в существующем cache driver. Свежие действия имеют разные UUID. Auth/gateway-отказ не уничтожает неизвестный ID | Исходный независимый probe PASS; реальные Chromium tabs + IndexedDB + native Web Locks + PostgREST: 6 групп PASS, включая lost ACK, lock timeout/reload, independent identical, Auth recovery и abrupt closure |
| REG-02 MEDIUM | PASS в проверенной области | Внешний watchdog завершал Promise, но не запрещал продолжение после identity/storage await | Signal, generation, account epoch и lifetime проверяются после await и до эффектов; отмена передаётся в ACL persistence/reconciliation и транзакции. Истёкший цикл не продвигает previous и не мешает новой проверке | Независимый identity probe PASS; query/identity/storage, reconnect, logout/epoch/unmount и реальные отменённые IndexedDB transactions PASS |
| REG-03 HIGH | PASS в проверенной области | Публичные unversioned RPC обходили CAS новых клиентов | Новая миграция переносит исходные реализации в private с закрытым EXECUTE; public legacy требуют upgrade через PT426. CAS/v2 используют прежние ACL/audit реализации. Защита полей останавливает и старые тела функций, уже ожидавшие lock | Реальный PostgREST: 9 семейств, legacy/executor refusals без эффектов, completed v1 replay, v2 dedup, concurrent CAS. Реальный старый запрос через cutover получает PT426; новый комментарий остаётся |
| SECURITY-01 MEDIUM | PASS WITH APPROVED EXCEPTION | Arborist строит effects и breaking-fix recommendation из Set, зависящего от порядка async расчёта. Gate сравнивал эти производные представления как изменение риска | Полный обратный граф выводится из via; неизвестные effects edges запрещены. Только два доказанных breaking-downgrade предложения одного meta finding считаются эквивалентными. Остальные поля/fixes, roots, nodes, lock, expiry и upstream checks остаются строгими | 24 frozen-input порядка: 3 raw формы → 1 fingerprint. По 3 live gate runs на Node 22/npm 10 и Node 24/npm 11 PASS с тем же исключением; 48 policy tests PASS |
| DEPLOY-01 HIGH | BLOCKED | Новый клиент требует отсутствующих production RPC; push может запустить внешние deployment paths, порядок не гарантирован | Подготовлен точный offline release plan и выполнена локальная CLI-репетиция 75+2 на свежем снимке production catalog. Доставка остановлена по условию пользователя | Production catalog: 5 отсутствующих capabilities; Timeweb push hook активен; GitHub main без branch protection, Production без protection rules; Vercel MCP 403, CLI без credentials. Production release gate не подтверждён |

## Механизмы исправления

### REG-01

Основной envelope остаётся в существующем IndexedDB/SQLite cache namespace `sync:mutation:*`. Серверная дедупликация использует прежнюю `private.client_operation_receipts`; офлайн-outbox v2 не изменён на вторую систему.

Контекст связывает retry с сохранённым ID до ожидания Web Lock. Browser sessionStorage хранит только handle текущей вкладки: это сохраняет связь при reload и при истечении lock wait после того, как другая вкладка уже получила ACK и удалила shared envelope. Закрытые вкладки не оставляют отдельных shared records. При резком закрытии до обработки ACK сохранённый running не считается доказательством работы: отсутствие живого Web Lock позволяет уточнить исходную операцию. Успешные handles/envelopes удаляются с проверкой ID/содержимого, не затрагивая другую операцию.

Без подтверждённого исхода ID не удаляется по TTL. Неотправленные отменённые работы не запускаются позднее. Общий срок ограничен 45 секундами; identity/cache шаги — 5 секундами, RPC — 20 секундами. Auth/gateway отказ возвращается как авторитетная ошибка, сохраняя handle для безопасного уточнения после восстановления.

Отдельные новые действия, в том числе одинаковые по содержимому, не coalesce в активную мутацию. Изменённый черновик при неизвестном исходе сначала явно уточняет прежнюю операцию и получает сообщение о необходимости проверки данных.

### REG-02

Проверка принадлежит конкретным generation/account epoch и AbortController. После cached read, каждого membership page, identity, invalidation persistence и перед reconciliation проверяется актуальность. Unmount/logout/reconnect аннулируют старый цикл. После timeout сохраняется возможность новой авторитетной проверки.

Signal передаётся в существующие cache/read-freshness механизмы и operation-scoped driver. Реальный IndexedDB open, завершившийся после отмены, закрывается без записи; отмена активного write прерывает транзакцию. Консервативная карантинная отметка, установленная ещё действительной проверкой, не превращается в offline allow из-за ошибки storage.

### REG-03: инвентаризация и переход

Защищены девять семейств draft write:

1. `update_project`.
2. `update_task`.
3. `update_task_template`.
4. `update_task_template_item`.
5. `update_task_item`.
6. `set_task_item_comment`.
7. `set_task_item_percentage`.
8. `set_task_item_state`.
9. `update_my_profile` — обнаружен при проверке всех legacy setters; baseline ника фиксируется при открытии редактора.

Legacy `set_task_item_progress` тоже приходит к контролируемому отказу. У трёх v1 outbox RPC сохранён replay ранее завершённых receipts; новая неверсированная запись отклоняется и не оставляет receipt. Очередь пользователя не очищается. Versioned v2 продолжает CAS, receipt replay и no-op version advancement.

Deadline уже требовал expected version. Создание, относительное перемещение, архивирование, membership/ownership и idempotent notification commands сохраняют свои атомарные бизнес-контракты. Относительный reorder шаблона использует исходную закрытую реализацию под прежними locks и ACL. CAS шаблонного пункта не принимает небезопасный абсолютный position без соответствующего контракта; используется отдельная относительная команда. Полный item edit имеет CAS-перегрузку для title/description/position.

Новая миграция: [20261021144300_regression_write_protocol.sql](<C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261021144300_regression_write_protocol.sql>). Защита полей и table locks закрывают окно старого in-flight тела функции. Старые реализации сохраняют валидацию, ACL и аудит. Direct DML/EXECUTE к private реализациям для клиентских ролей запрещён. Отдельно исправлена fail-closed проверка NULL admin-role в CAS entry point.

**77 уже существовавших migration files, включая ещё не закоммиченную миграцию предыдущего этапа, совпадают с исходными SHA256.** Они не переписаны. Типы сгенерированы из временной мигрированной базы.

## Независимые воспроизведения и корректировка фикстур

База доказательств: `C:/tmp/teamtrack-regression-20261021`.

- `independent.test.ts`: исходный REG-01 probe фактического executor и driver проходит; оба retry используют исходный UUID.
- `independent-permission.test.ts`: исходные behavioral assertions сохранены. В mock добавлен только новый dependency export `readAccountEpoch`; исходный файл сохранён в `independent-permission.original.txt`. После 10001 мс и позднего identity completion: ноль invalidation/reconcile вызовов.
- `legacy-cas.mjs` повторён без правок: теперь получает **PT426**, поэтому его прежнее ожидание успешного legacy вызова заканчивается отказом. `legacy-cas-controlled.mjs` явно проверяет HTTP 426/PT426 и сохраняет исходный invariant конечной строки: версии **1 → 2 → 2**, новый комментарий не перезаписан.
- Исходный `independent-snapshot.mjs` использовал unversioned position mutation и тоже получает PT426. В `independent-snapshot-versioned.mjs` заменена только fixture mutation на CAS с прочитанной версией. Все исходные pagination assertions сохранены: calls `[0,500,0,500]`, 501 уникальная запись после reorder; 500 полных записей после hard delete.
- Штатные SQL/API fixtures для нового клиента читают baseline перед новым действием. Явные CAS preconditions не заменяются; stale-draft tests сохраняются. Legacy RPC тестируются прямыми вызовами с ожидаемым PT426. ACL, audit/feed/fanout, counts и payload invariants сохранены.
- В старом release rehearsal fault injection добавлялся после явного COMMIT новой pending migration, где ожидать rollback завершённой транзакции некорректно. Injection перенесён внутрь транзакции только в disposable failed-plan copy. Оригиналы миграций не изменены. Ошибки первых попыток сохранены в логах.

## Регрессионные проверки

Все перечисленные PASS относятся к локальной проверенной среде; production rollout этим не подтверждается.

| Проверка | Результат | Доказательство в базе логов |
| --- | --- | --- |
| Node 22.23.4 / npm 10.9.9: `npm test` | PASS: connection policy, TypeScript, ESLint, **75 файлов / 865 тестов** | `final-node22.log` |
| Node 24.15.0 / npm 11.12.1: `npm test` | PASS: те же проверки, **75 / 865** | `final-node24.log` |
| Оригинальные REG-01/02 probes | PASS: 2/2 | `final-original-regressions.log` |
| Membership/storage/online mutation/policy targeted tests | PASS; signal/epoch/late completion и negative gates | `fix-core-final.log`, `fix-policy-v2-tests.log` |
| Настоящие multi-tab IndexedDB/Web Locks/PostgREST | PASS: 6 групп, один effect после потерянного ACK; разные IDs для новых одинаковых действий; timeout/reload/abrupt closure/Auth recovery | `fix-abrupt-browser-final.log` |
| Новый write protocol, реальный API и upgrade | PASS: 9 семейств, old in-flight refusal, v1 completed replay, v2 replay, ACL и CAS | `fix-protocol-api.log`, `fix-independent-legacy-controlled.log` |
| Fresh SQL chain | PASS: **17 SQL suites**, все миграции, concurrency, Data API; types regenerated | `fix-sql-fresh-final.log` |
| Upgrade SQL chain | PASS: **20 SQL suites**, legacy fixtures, реальные cron и concurrency | `fix-sql-upgrade-final.log` |
| RPC/RLS/security matrix fresh | PASS: **57 RPC / 674 сценария / 70 concurrency** | `fix-security-fresh-final.log`, `.expo/security-evidence/security-api-results-fresh.json` |
| Та же matrix `--hosted` | PASS: **57 / 674 / 70** на локально восстановленной catalog fixture; это не production write test | `fix-security-upgrade-final.log`, `security-api-results-hosted.json` |
| Backend/Auth/Realtime/PKCE/bootstrap | PASS: 7 integration scripts, реальные disposable сервисы, ownership/revoke races, password lifecycle, private Broadcast | `fix-backend-final.log` |
| Snapshot 501, CAS/dedup, keyset/copy 1001, deleted audit/revoke | PASS | `fix-followup-api.log` |
| Template boundaries 0/1/999/1000/1001/2001/5001, preview/copy, CAS/ACL | PASS | `fix-remediation-api.log` |
| Независимые reorder/delete между страницами | PASS, исходные pagination invariants | `fix-independent-snapshot-versioned.log` |
| RLS/Broadcast negative controls | PASS: старое поведение действительно проваливает probes | `fix-negative-controls.log` |
| Exported application в Chromium | PASS: 2 remediation сценария + 7 template groups; реальный Auth/API/Realtime, offline restart, draft conflict | `final-browsers.log` |
| Connectivity browser recovery | PASS: 6 сценариев, включая lost ACK, offline Refresh/outbox и автоматический reconnect | `fix-sdk-app-browser.log` |
| PWA Chromium + WebKit | PASS: navigation/body recovery около 5 сек, один update reload, errors=[] | `fix-sdk-pwa.log` |
| `npm run build:web` | PASS: 35 routes, SW/precache | `final-web-build.log` |
| Expo web/Android/iOS export с source maps | PASS: все три платформы, актуальный source | `final-all-platforms.log`, `.expo/regression-final-export` |
| Expo Doctor после patch alignment | PASS: **21/21** | `fix-sdk-doctor.log` |
| Security gate live repeats | PASS WITH APPROVED EXCEPTION: 3×Node22 + 3×Node24, неизменные зависимости/policy | `fix-final-security-node22.log`, `fix-final-security-node24.log` |
| Финальный gate по последнему 3-platform export | PASS WITH APPROVED EXCEPTION; raw npm audit FAIL | `final-policy-gate.log`, `.expo/security-policy/policy-result.json` |
| Frozen Arborist completion-order replay | PASS: **24 порядка / 3 raw формы / 1 нормализованный hash** | `fix-arborist-final-proof.log`, `fix-arborist-order-proof.json` |
| Official Supabase advisor SQL | PASS: **0 ERROR**, 74 WARN об authenticated SECURITY DEFINER RPC, 10 INFO о закрытых RLS private tables | Fresh/upgrade SQL logs |
| Точная production lineage в disposable DB, реальный Supabase CLI | PASS: **75 applied + 2 pending**, failure внутри transaction rollback, second dry-run empty, API schema reload, CAS, legacy PT426, canonical catalog equality | `fix-deploy-rehearsal-final.log` |
| Git diff/whitespace и рабочие файлы | PASS; нет staged files, новых secret candidates и изменений исторических миграций | `final-worktree-review.json` |

Первые полные Node 22 прогоны достигали стандартного 5-секундного лимита тяжёлого fake IndexedDB теста при массовом запуске 75 workers. Изолированно тот же тест проходит за 3.59 сек. В Vitest установлен maxWorkers=4; **тайм-ауты и все 20-cycle/storage assertions сохранены**. Финальные полные прогоны Node22/24 проходят. Первоначальные Node22 FAIL logs сохранены: `fix-unit-node22.log`, `fix-unit-node22-final.log`.

Первый финальный Expo Doctor обнаружил обновившиеся patch recommendations и дал 20/21; результат сохранён в `fix-expo-doctor.log`. После обновления SDK patches — 21/21. Ошибка не подавлялась.

### Сохранение прежних 11 PASS

| ID | Итог | Основная повторная проверка |
| --- | --- | --- |
| BUG-02 | PASS | HTTP snapshot 501, независимые reorder/hard-delete, полные restart/cache invariants |
| BUG-03 | PASS | Upgrade history fixture, deleted-item audit и текущий ACL/revoke через API |
| BUG-04 | PASS | Ownership/RLS/concurrency matrix и stage ACL suites |
| BUG-06 | PASS | PWA navigation + partial HTML body в Chromium/WebKit, updateReloads=1 |
| BUG-08 | PASS | Deadline PT409 component regression, API/concurrent save и черновик даты |
| BUG-09 | PASS | Rendered descriptions, SQL/HTTP independent template copy |
| BUG-10 | PASS | Windows child-process argv tests и DB connection policy |
| BUG-11 | PASS | Динамическая роль и переключение архив/активные в UI regression suite |
| BUG-12 | PASS | UTC+3 midnight, foreground/clock recovery, timer cleanup и оба daily-progress экрана |
| OTHER-01 | PASS | Keyset/revision/count и страницы до 5001, legacy reader/preview |
| OTHER-02 | PASS | Atomic bulk copy 1001/5001, порядок/descriptions и statement-level status/fanout |

## SECURITY-01: границы нормализации и остаточный риск

Причина подтверждена кодом установленного npm Arborist и отдельным replay его реального AuditReport с неизменными tree, bulk advisory data и calculator results. Async completion order меняет внутренние Set; seen(name@range) пропускает повторный обход. via сериализуется из полного advisory набора, effects — из отдельно накопленных обратных связей. Breaking-fix propagation сохраняет первый подходящий major downgrade.

Нормализация `arborist-derived-metadata-v2`:

- восстанавливает effects как полный reverse(via) и отвергает любой raw edge, не подтверждённый via;
- при одном `@react-native/metro-config` сводит только два точных несовместимых предложения: RN 0.72.17 или Worklets 0.7.4, оба isSemVerMajor=true;
- сохраняет строгую проверку остальных fixAvailable, неизвестных версий/имён, nonbreaking proposals, advisory metadata, severity, via, nodes, ranges, состава 18 findings, manifest/lock fingerprints, upstream fix и срока.

Исходный FAIL с raw graph b49a… и старый PASS f63b… остаются в прежних evidence. После SDK patch единственное изменение остальных risk fields — путь установленного CLI: `node_modules/@expo/cli` → `node_modules/expo/node_modules/@expo/cli`. Пересмотрены точные fingerprints; список root advisory и срок не расширены.

Финальные значения:

- Manifest SHA256: `6bde2d5dfbe38379538c0343a712a533a4944487b82cdcf152db1c442b50d126`.
- Lock SHA256: `da18c63f547c5280ede145aec933e9727e70ba868b2c5bcbd315271afbeb5997`.
- Normalized audit graph SHA256: `615432ec9baa597a3c08f6eab06797e9b1c722d211cd70d22c93d69076fd63fe`.

**Raw audit: FAIL, 18 HIGH, 0 CRITICAL.** Это meta findings двух прежних root advisory: [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) и [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Официальные metadata/latest повторно проверены gate. Пакеты отсутствуют в проверенных Web/Android/iOS source maps. Риск tooling не объявляется устранённым. Исключение заканчивается **25.10.2026 23:59 UTC+3** (`2026-10-25T20:59:00.000Z`).

Первичные источники реализации: [npm audit-report](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/audit-report.js), [npm Vuln](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/vuln.js). Локально проверены npm 10.9.9 и 11.12.1, не предположение о поведении другой версии npm.

## DEPLOY-01: production и безопасная последовательность

Read-only capture актуального production catalog/history: **75 applied migrations**, последняя `20261018103053_template_realtime_invalidation`. В production отсутствуют `execute_client_mutation`, item snapshot RPC, template page v2, `private.audit_item_parents` и `private.template_read_state`.

Совместимость:
- Текущий baseline client → текущий server: прежние контракты работают; часть project/template CAS уже присутствует.
- Новый client → текущий server: несовместим по executor/page-v2/snapshot capabilities; проверка подтверждает отказ без записи.
- Новый client → новый server: пройден локальный API/browser/upgrade набор.
- Старый client → новый server: прежнее чтение сохраняется; небезопасные draft writes получают PT426 и требуют обновления. Это контролируемый cutover, не прозрачная совместимость всех старых записей. Completed v1 receipts остаются доступными владельцу.

Проверены:
- GitHub CI workflow активен; рабочий workflow запускается на push/pull_request.
- Timeweb hook активен для push/pull_request; target host — api.timeweb.cloud. Секретный URL не раскрывается.
- Есть GitHub Production deployment от vercel[bot] на текущем HEAD.
- GitHub API: main не защищена (404 Branch not protected); у Preview/Production environments нет protection rules/branch policy.
- Vercel API для нужного team/project: 403 missing scope access. CLI с тем же scope не имеет credentials; интерактивный login остановлен. Deployment settings не менялись.

Подготовлен конкретный offline plan: `C:/tmp/teamtrack-regression-20261021/deployment-plan-current/manifest.json`. Он содержит ровно две unapplied forward migrations: предыдущую `20261020194125_audit_followup_integrity_and_scaling.sql` и новую `20261021144300_regression_write_protocol.sql`. Реальная CLI-репетиция прошла только во временной БД, восстановленной из текущего catalog snapshot.

До выпуска необходимы:

1. Отдельно разрешённое управление release gates Vercel/Timeweb: удержать клиентское продвижение до server verification и исключить внешний ungated push deploy.
2. Согласованный server-first window с сохранением пользовательских черновиков/очередей и уведомлением старых клиентов об upgrade. Применить две миграции в порядке plan только после отдельного разрешения.
3. Проверить реальные RPC signatures/grants, RLS, schema reload, capabilities и обязательный security gate на разрешённом production процессе.
4. Контролируемо выпустить клиент, проверить PWA update/старые открытые вкладки и обработку PT426/PT409. Несинхронизированные очереди не очищать.
5. При client rollback сохранить защиту от неверсированных записей. До истечения исключения необходим проверенный upstream fix либо новое явное решение владельца о риске.

Доступа для подтверждения/настройки этих release gates нет, разрешения на production migration нет. **DEPLOY-01 остаётся BLOCKED. Commit/push не выполняются.**

## Изменения зависимостей и архитектуры

Для обязательного Expo Doctor обновлены только верхнеуровневые SDK patches `expo 57.0.30 → 57.0.31` и `expo-router 57.0.28 → 57.0.29`. Их транзитивные требования изменили 46 lock entries, включая обязательные SDK CLI/config/plugins/UI/modules и их зависимости; diff сохранён в `sdk-lock-review.json`. Проверено: root advisory по-прежнему ровно два, affected finding packages — прежние 18; новое расположение CLI учтено явно. Ранее исправленный override Vite 8.3.3 сохранён.

Существующие coordinator/runtime, cache driver, outbox v2, Realtime, ModalLayer и RLS остаются владельцами соответствующих механизмов. Новый sync provider/timer/recovery queue не создавался. Добавлены retry handle вкладки и серверная защита протокола draft writes; бизнес-валидация и аудит используют исходные реализации.

## Git и область изменений

- Branch/upstream: `main` / `origin/main`.
- Remote: [Egor051/TeamTrack](https://github.com/Egor051/TeamTrack).
- HEAD и проверенный remote main: `3f33f4540cf383e3846e62ebd97309247f835704`.
- Итоговое рабочее дерево: **101 файл: 79 modified, 22 untracked**, включая изменения прежнего этапа.
- После независимого аудита изменено/добавлено 64 файла; 37 файлов прежнего remediation остались без дополнительных изменений.
- Индекс пуст. Staging, commit и push не выполнялись.
- Whitespace check и проверка рабочих файлов на новые credential candidates пройдены. Historical migration hashes сохранены.

Полный список рабочего diff; `M` и `??` — фактические Git statuses:

| Git | Файл | Отношение к независимому аудиту |
| --- | --- | --- |
| `M` | [.github/workflows/ci.yml](<C:/Users/chupa/proj/TeamTrack/.github/workflows/ci.yml>) | Изменён после независимого аудита |
| `??` | [docs/audit-followup-2026-10-20.md](<C:/Users/chupa/proj/TeamTrack/docs/audit-followup-2026-10-20.md>) | Изменён после независимого аудита |
| `??` | [docs/audit-regression-fixes-2026-10-21.md](<C:/Users/chupa/proj/TeamTrack/docs/audit-regression-fixes-2026-10-21.md>) | Новый файл этого исправления |
| `M` | [package-lock.json](<C:/Users/chupa/proj/TeamTrack/package-lock.json>) | Изменён после независимого аудита |
| `M` | [package.json](<C:/Users/chupa/proj/TeamTrack/package.json>) | Изменён после независимого аудита |
| `M` | [scripts/account-offline-browser-smoke.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/account-offline-browser-smoke.mjs>) | Изменён после независимого аудита |
| `??` | [scripts/audit-followup-integration.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/audit-followup-integration.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [scripts/audit-remediation-browser.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/audit-remediation-browser.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/audit-template-concurrency.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/audit-template-concurrency.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/checklist-deadline-browser.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/checklist-deadline-browser.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/checklist-deadline-integration.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/checklist-deadline-integration.mjs>) | Изменён после независимого аудита |
| `??` | [scripts/fixture-cas.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/fixture-cas.mjs>) | Новый файл этого исправления |
| `M` | [scripts/gen-types.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/gen-types.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [scripts/generate-service-worker.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/generate-service-worker.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [scripts/offline-navigation-browser-smoke.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/offline-navigation-browser-smoke.mjs>) | Изменён после независимого аудита |
| `??` | [scripts/package-runner.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/package-runner.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [scripts/phase5-browser-smoke.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/phase5-browser-smoke.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/phase6-browser-smoke.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/phase6-browser-smoke.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/pwa-mobile-browser-smoke.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/pwa-mobile-browser-smoke.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [scripts/regression-mutation-browser.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/regression-mutation-browser.mjs>) | Новый файл этого исправления |
| `??` | [scripts/regression-write-protocol.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/regression-write-protocol.mjs>) | Новый файл этого исправления |
| `M` | [scripts/run-audit-sql-tests.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/run-audit-sql-tests.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/run-backend-integration-tests.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/run-backend-integration-tests.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/run-bootstrap-integration-tests.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/run-bootstrap-integration-tests.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/run-concurrency-tests.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/run-concurrency-tests.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/security-policy-gate.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/security-policy-gate.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/security-policy.json](<C:/Users/chupa/proj/TeamTrack/scripts/security-policy.json>) | Изменён после независимого аудита |
| `M` | [scripts/security-realtime-lifecycle.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/security-realtime-lifecycle.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/security-receipt-races.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/security-receipt-races.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/sql-test-suites.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/sql-test-suites.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [scripts/stage-membership-integration.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/stage-membership-integration.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/template-realtime-browser.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/template-realtime-browser.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/template-realtime-integration.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/template-realtime-integration.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/test-security-deploy-plan.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/test-security-deploy-plan.mjs>) | Изменён после независимого аудита |
| `M` | [scripts/test-security-hardening.mjs](<C:/Users/chupa/proj/TeamTrack/scripts/test-security-hardening.mjs>) | Изменён после независимого аудита |
| `M` | [src/app/(app)/profile.tsx](<C:/Users/chupa/proj/TeamTrack/src/app/(app)/profile.tsx>) | Изменён после независимого аудита |
| `M` | [src/app/(app)/projects/[id]/progress.tsx](<C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/progress.tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/app/(app)/projects/[id]/tasks/[taskId].tsx](<C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/tasks/[taskId].tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx](<C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/components/ui/deadline-picker.tsx](<C:/Users/chupa/proj/TeamTrack/src/components/ui/deadline-picker.tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/features/auth/auth.ts](<C:/Users/chupa/proj/TeamTrack/src/features/auth/auth.ts>) | Изменён после независимого аудита |
| `M` | [src/features/auth/AuthProvider.tsx](<C:/Users/chupa/proj/TeamTrack/src/features/auth/AuthProvider.tsx>) | Изменён после независимого аудита |
| `M` | [src/features/auth/PermissionProvider.tsx](<C:/Users/chupa/proj/TeamTrack/src/features/auth/PermissionProvider.tsx>) | Изменён после независимого аудита |
| `M` | [src/features/notifications/notifications.ts](<C:/Users/chupa/proj/TeamTrack/src/features/notifications/notifications.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/features/projects/projects.ts](<C:/Users/chupa/proj/TeamTrack/src/features/projects/projects.ts>) | Изменён после независимого аудита |
| `M` | [src/features/projects/template-pages.ts](<C:/Users/chupa/proj/TeamTrack/src/features/projects/template-pages.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/lib/connectivity/deadline.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/connectivity/deadline.ts>) | Изменён после независимого аудита |
| `M` | [src/lib/connectivity/fetch.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/connectivity/fetch.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/lib/errors/user-message.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/errors/user-message.ts>) | Изменён после независимого аудита |
| `M` | [src/lib/local-cache/cache.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/cache.ts>) | Изменён после независимого аудита |
| `M` | [src/lib/local-cache/edit.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/edit.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/lib/local-cache/read-freshness.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/read-freshness.ts>) | Изменён после независимого аудита |
| `??` | [src/lib/local-cache/snapshot-pages.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/snapshot-pages.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/lib/local-cache/sync.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/sync.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [src/lib/local-cache/use-current-day.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/use-current-day.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [src/lib/supabase/mutation.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/supabase/mutation.ts>) | Изменён после независимого аудита |
| `M` | [src/lib/supabase/ui-read.ts](<C:/Users/chupa/proj/TeamTrack/src/lib/supabase/ui-read.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [src/types/database.types.ts](<C:/Users/chupa/proj/TeamTrack/src/types/database.types.ts>) | Изменён после независимого аудита |
| `??` | [supabase/migrations/20261020194125_audit_followup_integrity_and_scaling.sql](<C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261020194125_audit_followup_integrity_and_scaling.sql>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [supabase/migrations/20261021144300_regression_write_protocol.sql](<C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261021144300_regression_write_protocol.sql>) | Новый файл этого исправления |
| `M` | [supabase/tests/account_offline_bootstrap_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/account_offline_bootstrap_test.sql>) | Изменён после независимого аудита |
| `??` | [supabase/tests/audit_followup_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/audit_followup_test.sql>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [supabase/tests/audit_followup_upgrade_fixture.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/audit_followup_upgrade_fixture.sql>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [supabase/tests/audit_followup_upgrade_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/audit_followup_upgrade_test.sql>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [supabase/tests/audit_template_ordering_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/audit_template_ordering_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/checklist_deadlines_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/checklist_deadlines_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/concurrency_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/concurrency_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/full_integration_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/full_integration_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/hard_delete_history_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/hard_delete_history_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/independent_stage_membership_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/independent_stage_membership_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/notifications_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/notifications_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/offline_operation_receipts_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/offline_operation_receipts_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/offline_pull_conflicts_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/offline_pull_conflicts_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/rls_and_rpc_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/rls_and_rpc_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/stage_visibility_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/stage_visibility_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/task_enhancements_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/task_enhancements_test.sql>) | Изменён после независимого аудита |
| `M` | [supabase/tests/template_realtime_test.sql](<C:/Users/chupa/proj/TeamTrack/supabase/tests/template_realtime_test.sql>) | Изменён после независимого аудита |
| `M` | [tests/connectivity-recovery.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/connectivity-recovery.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [tests/current-day.test.tsx](<C:/Users/chupa/proj/TeamTrack/tests/current-day.test.tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/fixtures/security-policy-audit.json](<C:/Users/chupa/proj/TeamTrack/tests/fixtures/security-policy-audit.json>) | Изменён после независимого аудита |
| `??` | [tests/mutation-contexts.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/mutation-contexts.test.ts>) | Новый файл этого исправления |
| `M` | [tests/notification-count-cache.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/notification-count-cache.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/offline-auth-identity.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/offline-auth-identity.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/offline-auth-profile.test.tsx](<C:/Users/chupa/proj/TeamTrack/tests/offline-auth-profile.test.tsx>) | Изменён после независимого аудита |
| `M` | [tests/offline-connectivity.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/offline-connectivity.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/offline-outbox.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/offline-outbox.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/offline-phase6-runtime.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/offline-phase6-runtime.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/offline-sync.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/offline-sync.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [tests/online-mutation.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/online-mutation.test.ts>) | Изменён после независимого аудита |
| `??` | [tests/package-runner.test.mjs](<C:/Users/chupa/proj/TeamTrack/tests/package-runner.test.mjs>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/permission-provider-cache.test.tsx](<C:/Users/chupa/proj/TeamTrack/tests/permission-provider-cache.test.tsx>) | Изменён после независимого аудита |
| `??` | [tests/permission-storage-cancellation.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/permission-storage-cancellation.test.ts>) | Новый файл этого исправления |
| `M` | [tests/security-policy-gate.test.mjs](<C:/Users/chupa/proj/TeamTrack/tests/security-policy-gate.test.mjs>) | Изменён после независимого аудита |
| `??` | [tests/snapshot-pages.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/snapshot-pages.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/task-enhancements.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/task-enhancements.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/task-screen-loading.test.tsx](<C:/Users/chupa/proj/TeamTrack/tests/task-screen-loading.test.tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/template-list-cache.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/template-list-cache.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/template-mutation-contract.test.tsx](<C:/Users/chupa/proj/TeamTrack/tests/template-mutation-contract.test.tsx>) | Предыдущий этап; без изменений в этом исправлении |
| `M` | [tests/template-pages.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/template-pages.test.ts>) | Предыдущий этап; без изменений в этом исправлении |
| `??` | [tests/upgrade-message.test.ts](<C:/Users/chupa/proj/TeamTrack/tests/upgrade-message.test.ts>) | Новый файл этого исправления |
| `M` | [vitest.config.mts](<C:/Users/chupa/proj/TeamTrack/vitest.config.mts>) | Изменён после независимого аудита |

## Ограничения доказательств

Production migrations, production write/E2E smoke и изменение release settings: **SKIPPED по прямому ограничению пользователя**. Read-only catalog/CI/CD inspection выполнен.

Android/iOS проверены экспортом; Chromium/WebKit mobile profiles не являются физическими телефонами. Native device acceptance и production latency/SLO этим отчётом не подтверждаются. Удалённый GitHub CI run не инициировался, поскольку push запрещён; версия Node 22 проверена локальным полным прогоном.

Исходные FAIL, первый Doctor mismatch, Node22 resource-contention failures и последующие исправленные проверки сохранены отдельно в evidence. Необъяснённых ошибок актуальных обязательных поддерживаемых сценариев не осталось. Общая production readiness остаётся FAIL из-за DEPLOY-01.
