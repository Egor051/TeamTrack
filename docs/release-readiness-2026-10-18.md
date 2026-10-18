# TaskTrace: выпуск после B01–B04, P01 и RA-04

Этот документ — план, а не разрешение на deployment. Hosted Supabase, frontend production и секреты этим этапом не изменяются. Commit/push выполняются только после отдельной команды владельца.

## Security policy и граница выпуска

На 18.10.2026 полный `npm audit --omit=optional` возвращает **FAIL / exit 1 / 18 HIGH**: два открытых корневых advisory и связанные meta findings. Уязвимости не исправлены. Владелец проекта явно утвердил вариант Б: ограниченное временное принятие только RA-02/RA-03 до **25.10.2026 23:59 UTC+3**. Это **2026-10-25T20:59:00.000Z**; на этой границе и позже исключение уже не действует.

Отдельный security policy gate может вернуть **PASS WITH APPROVED EXCEPTION** только для проверенного состояния зависимостей, текущих официальных advisory и свежих Web/Android/iOS artifacts без этих модулей. Это не PASS самого npm audit и не устранение уязвимостей. Deployment пока не принят: нужны настоящий GitHub Actions, backup/restore и разрешения на Git delivery и production. Локальные PASS не подтверждают работу production или физических устройств.

## Серверная граница

Read-only capture текущей hosted-схемы и migration history показал **73** применённые миграции. Семь security-файлов из Git уже установлены под другими timestamps, но с эквивалентным SQL; `20261017012113_independent_stage_membership.sql` также установлен. Не следует повторно применять их только из-за несовпадения локальных имён файлов с историей.

На момент capture остаются ровно:

1. `20261017203226_audit_reliability_remediation.sql`: CAS overloads, scalar JSON pagination, deadline history RLS и детерминированный preview. Добавлен commit-time `NOTIFY pgrst, 'reload schema'`: уже работающий Data API должен увидеть новые signatures до выпуска клиента.
2. `20261018103053_template_realtime_invalidation.sql`: private global library topic и statement Broadcast triggers без данных строк.

Это применимо только к зафиксированной схеме. Перед deployment обязательно повторить capture и проверку drift. Migration history не заменяет проверку функций, grants, RLS, triggers, constraints, indexes и default privileges.

`scripts/prepare-security-deploy-plan.mjs` создаёт отдельный CLI workdir из фактической hosted history плюс только отсутствующие forward-файлы. Он проверяет SQL содержимое при совпадении имён/разных timestamps и отвергает неоднозначность или drift. Он не подключается и не выполняет SQL. Не использовать обычный `db push` из корня Git с исторически несовпадающей lineage; не использовать `--include-all` или `migration repair` для обхода расхождений.

Артефакты capture и план хранятся вне Git. Пример создания плана и локальной репетиции:

```text
node scripts/prepare-security-deploy-plan.mjs <history.json> <new-plan-dir> <schema.json>
node scripts/test-security-deploy-plan.mjs <history.json> <new-plan-dir> <schema.json>
```

Вторая команда имеет защиту `teamtrack_audit_<pid>` и использует только disposable локальную БД. Проверяются logical schema, реальный CLI dry-run/apply/retry, старая/новая форма RPC и работающий PostgREST. Physical attribute numbers и redundant owner-only per-schema default ACL rows нормализуются отдельно; global function defaults и все эффективные grants сохраняются в проверке. Схема, содержащая реальные пользовательские строки, туда не копируется.

## Порядок выпуска и остановки

| Шаг | Действие | Критерий успеха | Условие остановки |
|---|---|---|---|
| 1. Предрелизная граница | Сверить HEAD, exact diff, lockfile, migration SHA; выполнить local suites и настоящий CI на отправленном SHA | Код проверен на том же SHA; обязательные jobs PASS; policy gate PASS либо PASS WITH APPROVED EXCEPTION в пределах срока; raw audit сохранён | Красный policy gate/CI, любая новая уязвимость, истечение исключения, drift, непроверенный SHA |
| 2. Резервная копия | Проверить доступность managed backup/PITR у конкретного проекта; создать согласованную копию вне Git в защищённом хранилище; записать restore point и проверить восстановление в отдельном проекте | Проверена восстановленная схема и репрезентативные данные, Auth identities, audit, настройки; определён RPO/RTO; учтены внешние Storage objects | Нет проверенного restore point; неизвестная полнота/ключи расшифрования; копия хранится в checkout |
| 3. Hosted capture | Read-only снять actual history и полный schema inventory; сверить project ref, версию PostgreSQL, grants/RLS и migrations | Capture свежий; source-equivalent aliases распознаны; никакой неоценённый drift | История/схема изменилась; другое окружение; источник capture неизвестен |
| 4. План | Построить новый offline workdir; сравнить manifest SHA с reviewed files; повторить isolated rehearsal | Dry-run предлагает только две ожидаемые миграции в указанном порядке; повтор после успешной репетиции пуст | Любой historical replay, иной список, изменённый SQL, ошибка репетиции |
| 5. Сервер | После отдельного разрешения выполнить migration push из подготовленного workdir, используя защищённый pooler credential; frontend пока прежний | Миграции записаны; новые signatures видны на уже работающем API; legacy RPC всё ещё работают | Неуспешная SQL/lock/permission операция, неожиданные grants, PGRST202 для нового RPC, несовпадение числа миграций |
| 6. Проверка сервера | Отдельными временными тестовыми пользователями проверить RLS, CAS/PT409, page totals/revisions, deadline history и private Broadcast | Неавторизованные запросы отвергаются; разрешённые данные полны; событие не содержит строки; старый клиент совместим | Утечка данных, silent overwrite, truncation, отсутствие events/reload, ошибка workers |
| 7. Frontend | Выпустить собранный и проверенный artifact нового SHA после шага 6 | Правильные публичные URL/key; static Web; новые page/CAS RPC работают | Клиент оказался раньше сервера, неверное окружение/flags, JS/API ошибки |
| 8. Установленная PWA | Проверить online/offline launch, cached account, старый SW → новый, обычную перезагрузку открытых вкладок | Ровно одно подтверждённое обновление, нет reload loop; pending operations сохранены | Кэш/IndexedDB очищаются, потеря очереди/сессии, infinite reload, старый bundle использует отсутствующий контракт |
| 9. Android/iOS | Собрать/подписать APK/IPA в поддерживаемой среде; проверить реальные устройства и обновление существующей установки | Login/logout, роли, offline/reconnect, CAS и отображение проходят на физическом устройстве | Только Hermes export, неподписанный/неустановленный artifact, непроверенная миграция локального хранилища |
| 10. Приёмка | Две реальные сессии: проект/этап, шаблоны, checklist, revoke во время sync, failed cancel, независимая отправка, deadline notifications/history | Данные/доступ соответствуют серверу; черновики и очередь сохранены; нет лишнего full-refresh storm | Нарушение целостности, потеря локальных изменений, зависшая очередь, неверные ACL |
| 11. Наблюдение | Сравнить ошибки Auth/DataAPI/Realtime, CAS conflict rate, sync backlog и latency с измеренной baseline; наблюдать worker failures/overlap, не только число событий | Ошибки и backlog объяснимы, сервис восстанавливается, accepted write подтверждён сервером | Рост ошибок/очереди, пропущенные данные, неавторизованная выдача; остановить дальнейшее распространение |

Команды production push ниже — только пример для отдельного ручного исполнения после разрешения, не часть автоматических проверок:

```text
supabase --workdir <reviewed-plan-dir> db push --db-url <protected-pooler-connection> --dry-run
supabase --workdir <reviewed-plan-dir> db push --db-url <protected-pooler-connection>
```

Пароль/connection URL не помещается в Git, публичные EXPO переменные, отчёт или командный лог. Backup нельзя считать полным только потому, что команда dump закончилась успешно: требуется restore rehearsal. Managed DB backup не равнозначен резервной копии самих Storage objects; план их восстановления проверяется отдельно. См. [официальные ограничения Supabase backups](https://supabase.com/docs/guides/platform/backups).

## Версии клиента, кэш и частичный deployment

| Комбинация | Поведение и правило |
|---|---|
| Старый клиент + обновлённый сервер | Legacy RPC signatures сохранены. Новые guards/grants должны пройти compatibility rehearsal до клиента. Старый клиент сохраняет прежние функциональные ограничения; откат на него может вернуть исправленные баги. |
| Новый клиент + старый сервер | Новые page/CAS RPC получают PGRST202; нет fallback к capped list или незащищённой записи. Клиент выпускается только после server acceptance. |
| Первая миграция установлена, вторая не установлена | CAS/pages уже доступны, legacy пути сохраняются; межсессионная template invalidation ещё не принята. Frontend не выпускать. Пересняв history, исправить причину и продолжить forward. |
| Ошибка внутри миграции | Проверить DDL и migration history, а не считать ответ CLI достаточным. Изолированная проверка намеренно подаёт SQL error и контролирует rollback; повторяется исправленный план. |
| Старая template cache v1 | Новый клиент её не подтверждает как полную. Полный validated snapshot/server read формирует v2. Остальные cache models и pending_operations не переведены на новый формат. |
| Старые и новые вкладки | Старый код может снова записать template v1; новый должен отвергнуть её и обновить полными страницами. При обновлении SW согласованно перезагрузить вкладки, не очищая пользовательское хранилище. |
| Offline pending operations | Формат/идентичность/idempotency receipts остаются прежними. Нельзя сбрасывать IndexedDB/SQLite, site data или outbox для «лечения» обновления. Failed cancel касается только явно выбранной непринятой цепочки. |
| Потерянные Broadcast events | Rejoin инвалидирует соответствующие read models; данные заново проверяются через RPC/RLS. Broadcast не служит источником разрешений или полных данных. |

## Восстановление

**Frontend:** вернуть сохранённый ранее проверенный static artifact только после проверки совместимости его RPC с текущим сервером. Сохранить IndexedDB/SQLite и pending операции. Учитывать, что старый frontend может вернуть B01/B02/B03; предпочтителен исправленный forward build. После rollback перепроверить установленный SW, несколько вкладок, offline reload и очередь. Native rollback зависит от установленной версии и схемы локального хранилища; Hermes export этого не подтверждает.

**Database:** не выполнять обратный SQL и не удалять migration history автоматически. Две текущие миграции преимущественно добавляют RPC и заменяют read/trigger helpers; у них нет массовой переписи бизнес-данных. При частичной установке обычно сохраняется старый клиент и применяется проверенное forward исправление. При реальной порче данных остановить конкурирующие записи согласованным способом, определить принятые с backup-point записи и восстановить проверенный restore point в отдельном окружении. Сверить новые записи и outbox receipts, подготовить reconciliation/cutover. Грубый restore может потерять новые ACK/данные и повторно исполнить старую клиентскую очередь; требуется отдельное решение с RPO/RTO. Удаление cache/outbox не является восстановлением БД.

## Git

Рекомендуем один связный commit всего проверенного remediation/release набора:

`fix: harden offline recovery, template consistency and release validation`

После отдельной команды: fetch → проверить отсутствие divergence → повторить status/diff/secret/whitespace audit → stage только согласованные пути из manifest → проверить staged diff → commit → обычный push без force → проверить SHA и actual Actions. При drift остановиться и пересмотреть/перетестировать результат интеграции. Сам факт push не разрешает применение SQL или frontend deployment. Отдельно проверить, не запускает ли push существующий автоматический production deploy; в текущем workflow production job не добавляется.

После отправки: actual GitHub Actions на конкретном SHA, исходный audit JSON, отдельный policy result, SQL/backend/browser/PWA jobs, Hermes exports и отсутствие secret exposure. CI может пройти с ожидаемым raw audit FAIL только при действующем утверждённом исключении и успешных остальных проверках. Локальное выполнение gate не означает зелёного GitHub Actions.

## Ограниченное принятие риска — УТВЕРЖДЕНО ВЛАДЕЛЬЦЕМ 18.10.2026

Источник решения — явная задача владельца, вариант Б (attachment `e19b1a75-e347-4eb5-8e56-b4839d7fb609`). Решение ограничено текущим проверенным lockfile и архитектурой Expo/Metro, без production deployment и hosted mutations.

| Риск | Точная область |
|---|---|
| RA-02 | `braces@3.0.3`, **GHSA-vfj7-8cjw-p6xm**, npm source 1240992. Возможен stack exhaustion при недоверенных вложенных glob patterns. В проверенном Metro watcher path вызов braces не достигнут; это не доказательство безопасности всех инструментов. |
| RA-03 | `node-forge@1.4.0`, **GHSA-86w9-cpqp-85rv**, npm source 1240912. Недостаточно строгая RSA PKCS#1 v1.5 DigestInfo validation в signing/PKI tools. Собственный-key probe подтверждает дефект parser, не демонстрирует keyless exploit приложения. |

Официальных patched releases при повторной проверке нет. Свежие Web/Android/iOS source maps не содержат оба пакета. Прикладной маршрут недоверенного glob/signature input не найден. Это основание принятия остаточного build/development риска, а не признание библиотек безопасными. Официальные источники: [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv).

Механизм: `scripts/security-policy-gate.mjs` и `scripts/security-policy.json`. Полный audit выполняется с `--omit=optional --json` против официального npm registry; raw stdout и stderr сохраняются независимо от решения. Проверяются точные GHSA/source/package/range, весь reviewed граф `via/effects/nodes`, lock SHA256 и package manifest SHA256. Известные Metro/RN циклы допустимы только в том же графе с путём к одному из двух разрешённых root advisory; неизвестная или неразрешимая ветка блокирует CI.

Lock SHA256: `9759a5d892966c200aef86ee232570df36320259f90a63d4403cfbfa09968129`. Manifest SHA256: `f3e69479867009c65d67700ca9b725db0b6a29d47f632afb140b8ca8dc6f2bc5`. Audit graph SHA256: `f63bae014c20184286168ba194c63e8db5f18fe81f5bcd7378ba565e6f9a8f90`. Никакой команды автоматического обновления этих approval fingerprints нет. Любое изменение требует повторной оценки, даже если меняется только форматирование lockfile.

При каждом использовании исключения gate получает официальный GitHub advisory и latest npm release для обоих пакетов. Появление patched version, нового release, изменение scope/даты редактирования advisory или недоступность/невалидность metadata дают FAIL с требованием пересмотра. `npm audit` remediation suggestions, включая несовместимые downgrade, не считаются доказательством официального исправления и не применяются автоматически.

CI использует Node 22, `npm ci`, read-only repository permissions, `persist-credentials: false`, `EXPO_NO_DOTENV=1` и только синтетическую public Supabase configuration для static export. Секреты production не передаются. Свежие source maps создаются в ignored `.expo/security-export`, проверяются все три платформы; в deployable `dist` эти диагностические maps не добавляются. Исходный audit и policy decision загружаются как artifact `.expo/security-policy/` даже при отказе gate, без `continue-on-error` и suppression severity.

Локальный запуск после свежего экспорта всех трёх платформ:

```text
node scripts/security-policy-gate.mjs --bundles <fresh-export-directory>
```

В выводе и artifact различаются `npm audit: FAIL` и `Security policy gate: PASS WITH APPROVED EXCEPTION`. Невалидный/неполный JSON, ошибка registry/процесса, незнакомая структура или любая новая уязвимость (включая LOW/INFO) дают FAIL. При полностью чистом корректном audit — обычный PASS без исключения; изменённые lock/manifest всё равно требуют reassessment.

| Условие | Утверждённая граница |
|---|---|
| Объём | Только два названных advisory и их подтверждённые meta dependencies, без blanket HIGH exception. Production runtime/build/development оцениваются отдельно. |
| Срок | До 25.10.2026 23:59 UTC+3 либо до появления исправления/изменения условий — что наступит раньше. Автоматического продления нет. |
| Предпосылки | Только проверенные static/Hermes artifacts без этих модулей; текущие источники glob/signature; зафиксированный lockfile; сборка изолирована от production credentials; dev Metro не публикуется как production endpoint. |
| Сохранение контроля | Полный npm audit продолжает выполняться и сохраняться; любое новое advisory или иной dependency path требует остановки. Реализовано только явно разрешённое исключение двух GHSA; расширение scope или срока требует нового решения владельца. |
| Пересмотр | Проверять official releases, upstream fixes и dependency chains перед каждым выпуском; после доступного исправления выполнить полный набор compatibility/CI/build/security checks. |
| Немедленная отмена | Истечение срока; новый runtime import; внешние glob patterns/проверяемые подписи/low-exponent trust keys; изменение signing или CI trust; новый advisory; drift от проверенного lockfile; обнаруженный прикладной exploit. |
| Остаток | Отсутствие найденного прикладного пути не доказывает безопасность инструментов. Неподписанный/unmerged crypto patch и фиктивная версия не считаются исправлением. |

Исключение действует только при выполнении всех проверяемых предпосылок. Проверяется `Date.now()` относительно абсолютного UTC instant, без локального часового пояса и без CLI/env override времени. Срок повторно проверяется перед завершением gate, чтобы пересечение deadline во время сетевой проверки не дало PASS. Автоматического продления нет. После expiry audit продолжает выполняться, а исключение возвращает FAIL. Непроверенные GitHub Actions, backup/restore, миграции и device acceptance остаются следующими отдельными этапами, в прежнем порядке.
