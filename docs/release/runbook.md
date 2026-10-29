# TaskTrace: контролируемый выпуск после F01–F09

Подготовлено 25.10.2026; security-раздел обновлён 29.10.2026. Это план будущего выпуска. Production-действия этой задачей не выполнялись и не разрешены. Текущая готовность: **HOLD**. F06 оценивается постоянным реестром рассмотренных рисков; подтверждение управления hosting providers и остальные условия выпуска остаются обязательными.

## Обязательные условия

- Утверждён точный commit, прошли CI и `release-acceptance-decision` этого SHA; security job успешен на основании чистого аудита либо записанных рисков, чьи условия сейчас проверены. Raw audit сохраняется без фильтрации.
- В Vercel и Timeweb подтверждены project, branch, domain, команда сборки и выключенная автоматическая production-публикация. Красный GitHub CI сам по себе не является барьером.
- Подтверждены backup/PITR, свободное физическое место, restore drill, доступ DBA и возможность закрыть внешний трафик до восстановления БД.
- Проверены поддерживаемые PWA/native версии и совместимый rollback artifact. Старый HEAD 810f1a3 не является разрешённым rollback после перехода на v3.
- Оператор согласовал SLA offline/replay и обе policy. Примерные параметры ниже не записывались в production.

## F06: постоянный реестр рассмотренных рисков

Актуальная исполняемая политика находится в `scripts/security-policy.json`; техническая оценка, advisory и ограничения приведены в `docs/security-risk-register-2026-10-29.md`. Security gate сохраняет фактический результат полного `npm audit`. Неизвестное advisory, изменение severity/range, расширение dependency roots, появление пакета в клиентском bundle, недостоверный аудит, сбой источника metadata или нарушение компенсирующей меры дают `FAIL`.

`node-forge` обновлён до исправленного совместимого `1.4.2`. Остаточные записи для Zod и deepmerge не имеют даты истечения: их статус сохраняется, пока gate подтверждает зарегистрированные условия. Любое появление совместимого исправления, новый путь к уязвимому коду, изменение входов/доверенной границы или потеря защитного условия требует пересмотра.

`npm run build:web`, CI и совместимый rollback используют `scripts/security-export.mjs`: только unsigned export, принудительный `EXPO_NO_DOTENV=1`, отказ при signing config/известных signing или cloud credentials/Node preload. Dev server по умолчанию запускается на localhost. Внешний привилегированный EAS/signing и сетевой DevTools не входят в принятый scope; перед таким использованием требуется отдельная оценка. Это ограничение не меняет production settings.

Gate проверяет фактический полный audit, связи advisory, текущие lock/manifest, установленные уязвимые пакеты, root dependency reachability, актуальные Web/Android/iOS source maps и соответствие provenance текущему checkout. Файлы не блокируются только из-за отличия от ранее согласованных хешей. F07 и production hold остаются самостоятельными условиями выпуска.

## Подготовка и управление hosting

1. До первого push владелец отключает automatic deploy у Timeweb-приложения и подтверждает отключение активного GitHub hook **689256349** либо его безопасную остановку в настройках конкретного приложения. Hook подписан на push/pull_request; branch filters и привязанное приложение агенту недоступны. Нужен подтверждённый app ID, а не предположение по URL webhook.
2. Владелец получает доступ к Vercel scope `team-track3`, project `tasktrace` / `prj_tzHtQo4RfFZojDSLfNLw5u3lACsS`. Чтение настроек в этой задаче вернуло **403**. Локальный `vercel.json` теперь содержит `git.deploymentEnabled=false`; нужно отдельно подтвердить действующий hold до push, поскольку текущая удалённая конфигурация ещё прежняя.
3. Оба провайдера используют `node scripts/release-host-build.mjs`. Для Timeweb это отдельное обязательное изменение настроек владельцем; оно не выполнено агентом. Сборка требует exact `TASKTRACE_RELEASE_APPROVED_SHA`, чистый tracked checkout и файл успешного acceptance из доверенного GitHub run через `TASKTRACE_RELEASE_ACCEPTANCE_FILE`. Проверяются SHA, hash manifest и успех static/database/security. Этот файл не является криптографической аттестацией: оператор проверяет источник artifact и соответствующий run URL.
4. До открытия production подтвердить hold наблюдаемым состоянием провайдеров и существующих deployment queues. Не делать пробный push ради проверки. Сборка/preview/promotion допускаются только отдельным разрешением владельца; если разделение публикации не подтверждено — **STOP**.

## Проверка схемы и recovery

5. Из доверенного соединения именно с проектом `diapmbqdjunlgvivwrtp` выполнить только чтение `docs/release/preflight.sql`, сохранить JSON и проверить `node scripts/release-preflight.mjs --catalog <saved-json>`. Сам инструмент не подключается к БД. Сравниваются raw определения функций, владельцы/ACL/search_path, schema grants, tables/views, RLS, columns, constraints, triggers, indexes и migration history. Любое отличие — **STOP**, новый разбор до изменения БД.
6. Проверить `node scripts/release-manifest.mjs --check`. Manifest содержит **ровно шесть** новых SQL, их hashes, порядок и зависимости, hashes preflight/maintenance и digest исторических файлов. Исторические 18 local-only, 17 remote-only и расхождения имён не исправлять автоматически. Общий `supabase db push` запрещён этим планом.
7. Проверить backup и restore drill на разрешённой копии. Для любого восстановления нужен внешний traffic fence, который переживёт rollback БД. Восстановленная таблица `release_write_control` сама по себе таким fence не является. После restore до открытия API выполняются generation rotation и проверка отказа потерянным будущим handles.

## Плановый maintenance и шесть миграций

8. Закрыть новые пользовательские записи плановым maintenance: выполнить утверждённый `docs/release/prepare-maintenance.sql`. Одна транзакция сначала дожидается writers на public tables, устанавливает общие statement guards и сохраняет `maintenance=true`. При lock timeout транзакция откатывается; следующий шаг запрещён. Проверить фактический отказ **503 / TT_RELEASE_MAINTENANCE** через разрешённый canary старого RPC и отсутствие эффекта. UI-баннер не считается fence.
9. Применять только файлы из manifest, каждый с проверенным SHA-256, последовательно:

| Шаг | Файл | Успех | При отказе |
|---|---|---|---|
| M1 | `20261022201114_audit_task_snapshot_revision.sql` | Backfill/revision/trigger/ACL; snapshot целевого этапа не зависит от чужого | Держать maintenance и hosting hold; остановить цепочку |
| M2 | `20261022201149_audit_rpc_outcomes.sql` | Historical HTTP outcomes и replay сохраняются | То же; следующие файлы не выполнять |
| M3 | `20261022202128_audit_receipt_budgets.sql` | Compact fingerprint, accounting, NULL policy fail-closed | Не открывать запись с NULL; предыдущие commits остаются |
| M4 | `20261023115036_operation_window_protocol.sql` | Namespace/functions/private ACL появились | Новый клиент не выдавать |
| M5 | `20261023115657_operation_window_lifecycle.sql` | Lifecycle/immutable guards/fences/cron зарегистрированы | V3 traffic остаётся закрытым |
| M6 | `20261024142519_release_blocker_guards.sql` | Общий maintenance/account guard, namespace fence, multi-user GC и initialization helpers | Исправлять вперёд на копии; не отключать guards и не удалять receipts |

Каждый файл содержит собственные BEGIN/COMMIT. Внешний BEGIN не делает шесть файлов атомарными. После каждого шага проверить maintenance=true, отсутствие бизнес-эффектов при отказе, наличие ожидаемых объектов/ACL. Успешные версии регистрируются оператором в migration history только после подтверждённого commit соответствующего файла; чужие исторические версии не помечаются applied. При неоднозначном ответе сначала читать schema/history и проверять hashes, не исполнять миграцию вслепую повторно.

До M6 helper открытия maintenance может отсутствовать: это ожидаемое безопасное состояние. После сбоя любого шага нельзя открывать сервис ручным сбросом флага. Сначала восстановить согласованную схему и пройти проверки.

## Согласованная настройка

10. Под maintenance одна транзакция вызывает **private.configure_client_operation_release(legacy_json, window_json)**. Функция недоступна API-ролям и обновляет обе policy атомарно; проверяет CHECK, полноту/cutoffs, фактические live budgets и запас под новую запись. Ошибка сохраняет прежние значения и закрытую запись. Не использовать значения тестовых fixtures.

Условный pilot: до 100 DAU, примерно 20 claims/день/DAU, средний accounted_bytes ≤2 KiB. После измерения исходного legacy накопления кандидат:

| Policy | Параметры |
|---|---|
| legacy | max_receipts=25000; max_logical_bytes=33554432; max_request_bytes=524288; max_result_bytes=262144; new_per_minute=120 |
| window | те же пять; admission_seconds=86400; replay_seconds=2592000; max_global_receipts=500000; max_global_bytes=536870912 |
| cutoffs | legacy_admit_until=T0+30 дней; legacy_replay_until=T0+120 дней; **абсолютные UTC timestamps утверждает оператор** |

T0 — согласованное открытие контролируемого релиза. При существующих pre-release UUIDv4 v3 receipts legacy admission обязан закрыться не позже их replay_until; helper отвергнет более поздний cutoff. UUID/handles таких записей не менять. Если необходимый cutoff несовместим с поддержкой старых клиентов — STOP и отдельный план перехода.

При 1000 DAU ×20/day ×31 день требуется около 620000 receipts; 500000 недостаточно даже при исправленном GC. Для 10000 DAU тот же профиль даёт 6,2 млн и примерно 11,83 GiB logical при 2 KiB. Кандидаты для новой нагрузочной приёмки: 1 млн/2 GiB для 1000 DAU и 10 млн/20 GiB для 10000. Это не одобренная production-конфигурация. Физическое место, индексы (включая новый namespace index), MVCC/WAL/backups и legacy считаются отдельно.

11. Проверить `private.assert_release_policies()`, суммы budgets, cron `tasktrace-operation-lifecycle`, роль postgres, database, активность и команду с **statement_timeout=20s**, расписание каждые пять минут. Наличие callable function без job не считается выполненной настройкой. Не подменять cron проверкой старого deadline job.

## Клиент, canary и promotion

12. Проверить поддерживаемый artifact: Web IDB v5; чтение существующего v6 без downgrade; SQLite v6; ключ `sync:mutation:v3:`; новые UUIDv8; retry сохраняет full handle. Не очищать storage или outbox. Old v5 opener несовместим с уже существующим pre-release IDB v6; использовать совместимый artifact. Старый native sync отвергает v3 как unsupported, а сервер не принимает UUIDv8 в legacy даже после GC.
13. Под maintenance выполнить отрицательную canary-проверку отказа и read-only `docs/release/postconditions.sql`. Затем согласованно открыть запись через **private.set_release_maintenance(false)** и выполнить разрешённые положительные canary-проверки до выдачи нового клиента. Helper не откроет запись при неполной policy. Проверить старый клиент в разрешённом legacy окне, новый v3, independent/new против retry, CAS, lost ACK, offline reconnect, review, Realtime и сохранность бизнес-данных. При неуспехе вернуть maintenance и остановить promotion. Если canary пишет, это отдельное разрешённое production-действие владельца; в этой задаче его не было.
14. Только после этого выдавать новый клиент на обоих hosts одним проверенным SHA. Старые SW tabs должны продолжать безопасную работу в пределах контракта. Новую сборку до завершения server/config этапов не публиковать. Native binary/OTA выпуск требует самостоятельной проверки поддерживаемых платформ и физических устройств.

## Наблюдение и recovery

15. Наблюдать user/global/legacy count и bytes, GC rows/users/tick, oldest eligible epoch, backlog и его производную, failed/duration cron jobs, locks, p95/p99 business latency, 503/429/507, disk/index/WAL/autovacuum. Начальные пороги pilot: warning 70% бюджета; 85% — остановка расширения. Устойчивый рост backlog, ошибочный effect/replay, потеря handle, отказ разрешённого аккаунта или нарушение ACL — остановка promotion и server maintenance/внешний fence по риску.
16. Перед T0+30 проверить обновляемость старых клиентов и сверку offline drafts; перед T0+120 — готовность к окончательному отказу legacy replay. Необратимо закрытую историю нельзя открыть переносом даты назад. Не возвращать очищенный ID в legacy/new namespace.
17. Rollback клиента: использовать **отдельный совместимый v3 artifact**, собранный `node scripts/build-compatible-rollback.mjs`, с проверенным source hash и утверждённой public config. Локальные экспорты с ci.invalid помечены verification-only. Старый бинарник/HEAD не применять после v3. Schema rollback удалением таблиц/receipts запрещён.
18. При restore: внешний traffic fence → backup/PITR → проверка схемы/данных → privileged generation rotation и commit → отказ старых handles → проверка ACL/budgets и canary → открытие API. Сохранить диагностику; ни unknown, ни expired не повторять автоматически новым ID. Восстановление очереди из резервной копии storage должно сохранять все namespaces и зависимости.

Итоговый успех выпуска требует подтверждённых provider settings, зелёного обязательного CI/security решения, сверки данных/метрик и реальной платформенной приёмки. Этот документ не объявляет production READY.
