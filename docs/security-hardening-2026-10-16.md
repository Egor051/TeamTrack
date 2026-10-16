# TaskTrace: устранение замечаний безопасности, 16 октября 2026

Вердикт: **READY WITH CONDITIONS**. Исправления подготовлены и проверены локально. Применение к hosted Supabase и обновление её PostgreSQL остаются отдельными этапами с подтверждением владельца.

Финальная проверка завершена 17 октября 2026 по часовому поясу проекта (Europe/Simferopol). Дата снимка схемы и имена миграций сохранены: 16 октября.

Исходный и повторно проверенный `HEAD == origin/main`: `2f1f0cc726d1a97219063a70d71cea6968b70443`. В рабочем дереве находятся изменения этого задания. Commit, push и deploy не выполнялись.

## Граница выполненной работы

Hosted `diapmbqdjunlgvivwrtp` использовался для чтения каталога, истории миграций, версии и Security Advisor. Реальные пользовательские строки не использовались для атак. Повторный снимок в конце работы совпадает с исходным по всем собранным коллекциям каталога. Hosted остаётся на PostgreSQL `17.6`, образ `17.6.1.171`, `ACTIVE_HEALTHY`; история содержит 65 миграций.

Все DDL, записи, проверки отрицательных сценариев, Auth-аккаунты, cron и браузерные операции выполнялись на синтетических данных в удаляемых БД `teamtrack_audit_<pid>` и отдельных контейнерах. Общая локальная БД приложения не сбрасывалась. `npm run test:sql` намеренно заменён изолированным runner: обычная команда сбрасывает общую локальную БД.

Локальная проверка обновления использовала официальный [образ 17.11.0.004](https://github.com/supabase/postgres/releases/tag/17.11.0.004) `public.ecr.aws/supabase/postgres:17.11.0.004`, digest `sha256:6058a6759ab9268cff8ee70641d61f1bd75953316281b76427cf5a6b4db2eafc`. Это проверка локального образа, а не выполненный upgrade managed-проекта на aarch64.

## 1. Согласование схемы и истории

Перепроверены реальные тела 120 функций, владельцы, `SECURITY DEFINER`, конфигурации, ACL, таблицы/колонки, типы, views, ограничения, индексы, триггеры, политики, схемы и defaults. SQL снимка: `supabase/tests/security_snapshot.sql`. Снимок hosted без пользовательских данных: `supabase/tests/fixtures/hosted_security_baseline_20261016.json`.

До исправления история Git содержала 66 миграций, hosted — 65: 11 версий только в Git, 10 только в hosted, 19 совпадающих версий с разными именами. Имена и номера не использовались как доказательство эквивалентности SQL. Сравнивались сохранённые statements и действующий каталог.

| Коллекция | Различающихся записей до согласования |
| --- | ---: |
| Функции, включая ACL/конфигурации/формат тела | 23 |
| Ограничения, включая выражения и validation state | 12 |
| Индексы | 7 |
| Таблицы/views/sequences, в основном ACL | 17 |
| Физические ordinal колонок | 2 |
| Триггеры | 1 |
| Схемы | 1 |
| Default ACL | 3 |
| Политики RLS и типы | 0 |

Эти числа описывают различия каталога, а не количество уязвимостей. Часть различий была эквивалентной записью SQL или историческим ACL.

В изоляции воспроизведены обе линии: fresh install всех 73 Git-миграций и реконструкция действующей hosted-схемы с последующим применением только семи новых миграций. Существенные различия устранены. Согласованы тела функций, ограничения, индексы, триггеры, политики и defaults. Повторное применение всех семи forward-файлов не вызывает schema drift.

Сохранены две явные исторические особенности:

* `set_updated_at()` и `prevent_history_mutation()` в hosted имеют authenticated EXECUTE, а fresh install — owner-only. Запрошенное сохранение EXECUTE соблюдено. Обе функции возвращают `trigger`, вызываются триггерами и не дают обычному клиенту DDL/TRIGGER-права. Это не дополнительный бизнес-RPC.
* Физический порядок `comment`/`percentage` в `task_items` различается. Для его изменения потребовалась бы перестройка таблицы. Приложение использует имена колонок и JSON; перенос данных и зависимостей ради ordinal не выполнялся. Fixture сравнивает логическую структуру и отдельно документирует эту особенность.

Validation state ограничений может законно зависеть от старых данных. Существующие невалидные имена/длинные тексты сохраняются под `NOT VALID`; новые записи продолжают проходить CHECK. Upgrade-тест действительно включает односимвольное имя, длинные тексты и старую историю и проверяет их сохранность.

### Каноническая перестановка шаблонов

Выбран обычный, недеферрируемый `UNIQUE(template_id, position)` и перестановка через свободную временную позицию. Hosted уже использует этот вариант; на ней перестройка UNIQUE не нужна. Fresh install заменяет прежний DEFERRABLE UNIQUE.

Родительская строка шаблона сериализует append, изменение текста, swap, delete и copy. `create_task_template_item` добавляет в конец; допустимый старый `p_position` сохраняется как совместимый аргумент. Отрицательные и нечисловые/бесконечные позиции отклоняются. Reorder не перезаписывает независимо сохранённые title/description. Copy создаёт плотные позиции в новом этапе. Проверены конкурентные append, edit → reorder/copy, delete → ожидающий reorder, а также API-вызовы всех четырёх функций.

## 2. Семь forward-миграций

| Файл | Назначение | Проверена в изоляции | Применена в hosted |
| --- | --- | --- | --- |
| `20261016191158_reconcile_security_schema.sql` | Канонические шаблоны/UNIQUE, эквивалентные CHECK, недостающие индексы, status-trigger, внутренние пути, notification initplan, закрытие service-view | Да, обе линии и 17.11 | Нет |
| `20261016191208_secure_application_default_privileges.sql` | Глобальный PUBLIC EXECUTE и per-schema defaults роли postgres | Да | Нет |
| `20261016191219_pin_history_timestamp_search_paths.sql` | Фиксация пути двух public trigger-функций | Да | Нет |
| `20261016191229_restrict_service_rpc_execution.sql` | Отзыв 11 избыточных service EXECUTE | Да | Нет |
| `20261016191239_progress_alias_security_invoker.sql` | Совместимый progress alias → INVOKER | Да | Нет |
| `20261016191251_member_identifier_abuse_protection.sql` | Валидация, квота, одинаковые business-denial, reload API cache | Да, включая живой PostgREST при upgrade | Нет |
| `20261016191301_minimize_client_table_privileges.sql` | REFERENCES/TRIGGER/MAINTAIN на девяти таблицах | Да | Нет |

Исторические миграции не переписаны. `migration repair` не выполнялся. Наличие нового пути согласования не означает, что hosted уже изменена.

## 3. Defaults, search_path и минимизация ACL

Причина небезопасных defaults: отзыв per-schema грантов не отменяет глобальный стандартный PUBLIC EXECUTE. Добавлен глобальный revoke для будущих функций, создаваемых ролью `postgres`, и удалены положительные API-defaults в `public`/`private` для функций, таблиц и sequences. Другие creator-роли и существующие provider-объекты не меняются.

SQL-тест создаёт новые SD-функции, таблицы и sequences в обеих схемах под настоящей ролью `postgres`. `anon`, `authenticated`, `service_role` не получают доступ автоматически; отдельно проверяется PUBLIC и работоспособность последующего явного GRANT.

У `public.set_updated_at()` и `public.prevent_history_mutation()` изменён только путь: `pg_catalog, pg_temp`. Тела и EXECUTE сохранены. Проверены четыре timestamp attachment и шесть attachment неизменяемой истории; история по-прежнему защищена от изменения/удаления.

У 11 указанных аудитом RPC отозван только service EXECUTE. Authenticated-доступ и необходимые SD сохранены. Поиск в исходниках/скриптах, действующие cron jobs от `postgres` и отсутствие hosted Edge Functions не выявили зависимости известных интеграций от этих грантов. Отдельный владелец должен подтвердить отсутствие внешних, не отражённых в репозитории потребителей service RPC.

У девяти таблиц (`profiles`, `projects`, `tasks`, `audit_log`, `item_actions`, `task_items`, `project_members`, `task_assignees`, `task_members`) убраны REFERENCES/TRIGGER/MAINTAIN для authenticated. SELECT/RLS сохраняются. INSERT/UPDATE/DELETE/TRUNCATE клиентам не открывались. Проверены каталог ACL и реальные HTTP-запросы прямого DML; отрицательные сценарии сравнивают данные и побочные эффекты до/после.

`set_task_item_progress(uuid,integer)` оставлен с прежними именами аргументов и типом результата. INVOKER-wrapper делегирует каноническому `set_task_item_percentage`; усиленная функция выполняет проверку доступа. Старые клиенты не требуют удаления alias.

## 4. Добавление участника по идентификатору

Исходная функция различала отсутствие пользователя, неоднозначное имя и уже существующего участника; количество обращений к глобальному каталогу не ограничивалось. Полностью убрать различие «добавлен / не добавлен» без изменения продукта на подтверждаемые приглашения нельзя.

Сохранено добавление по email/display name. До глобального поиска проверяются auth, обязательные аргументы, роль, длина 1–320 после trim, owner/admin, и активность проекта. Admin не может назначить admin. Поиск точный, без wildcard. Для not found / ambiguous / already member возвращается одинаковый фиксированный ответ.

Добавлена закрытая `private.member_identifier_limits`: один bucket на актёра по всем проектам, 20 обращений за календарную минуту. Неудачные поиски учитываются. Atomic upsert/row lock не даёт параллельным запросам потратить больше лимита. Запись не хранит идентификатор; число строк ограничено числом пользователей и очищается FK при удалении пользователя.

Важная причина изменения контракта: SQL exception откатывает и счётчик; это следует из [транзакционной модели PostgREST](https://docs.postgrest.org/en/v14/references/transactions.html) и подтверждено HTTP-тестами. Поэтому business-denial возвращает JSON с `response.status=400`, а исчерпание квоты — JSON с HTTP 429, `PT429` и Retry-After. PostgREST коммитит только security-counter; membership, audit, notifications и sync feed при отказе не меняются. Имена аргументов сохранены; успешный ответ теперь `{success:true}`. Клиентский SDK получает обычный `error` на 400/429; UI отображает безопасное сообщение.

**SQL-клиенты должны проверять JSON-результат; `PERFORM` больше не означает успех business-операции.** В известных исходниках таких SQL-потребителей нет. Неожиданная SQL-зависимость блокирует DROP без CASCADE и требует проверки.

Проверены пустой/длинный ввод и NULL/owner role, точное совпадение трёх error-envelope, 20 отказов + 21-й HTTP 429, сохранность квоты после HTTP error, новый bucket, 25 параллельных запросов по двум проектам (20 отказов + 5 лимитов), отдельная квота другого актёра, trim/case-normalization успешного email и запрет обхода через `Prefer: tx=rollback`. Последняя проверка выполнена с `db-tx-end=commit`; hosted-конфигурацию транзакций API нужно подтвердить до включения квоты. Условие: commit по умолчанию и запрет клиентского rollback override.

После изменения типа `void → jsonb` миграция отправляет `NOTIFY pgrst, 'reload schema'`. Реальный CLI-upgrade проверен с уже работающим PostgREST: новый JSON/error-контракт заработал без перезапуска контейнера.

Остаточный риск: разрешённый owner/admin всё ещё отличает успешное добавление от отказа. Квота ограничивает такой oracle, но не устраняет multi-account abuse или необходимость общей защиты периметра. Асинхронные email-приглашения в этом задании не вводились.

## 5. ACK, конкуренция и Realtime

Протокол идемпотентности оставлен без изменений. Подтверждено, что повтор своего ранее принятого operation возвращает тот же сохранённый ACK после revoke, downgrade, archive и hard delete. Между исходным ACK и повтором серверное содержимое меняется; повтор не раскрывает новое содержимое. Новая операция проверяет актуальные права; другой пользователь не получает чужую receipt; иной payload с тем же operation ID отклоняется.

V1/V2 × comment/percentage/state проверены параллельными дублями: одна receipt, один audit, один feed event, ожидаемый item action и один fanout уведомлений. Независимые V2 CAS: одно применение и один conflict. Отдельные блокируемые гонки доказывают повторную проверку после committed revoke/downgrade/archive/delete; две передачи владения оставляют одного owner. Deadlock или несанкционированная запись в этих прогонах не обнаружены.

Настоящий Realtime проверен отдельным контейнером: private project/user topics, межпроектная изоляция, доставка Broadcast, reconnect/rejoin, revoke, новый JWT после revoke, восстановление membership и downgrade до viewer. Прямые чтения/записи после revoke блокируются; повторный join запрещён.

Браузерный прогон обнаружил дополнительную ошибку классификации: `SupersededReadError` наследовалась от `ResourceAccessDeniedError`. Поэтому отмена устаревшего чтения при конкурентном invalidation могла вызвать переход в `/projects`, как будто сервер отказал в доступе. Теперь это отдельная обычная ошибка жизненного цикла. Epoch/CAS-ограждения, запрет публикации устаревшего ответа, ACL quarantine и настоящие 401/403/42501 остаются действующими. Добавлен детерминированный тест invalidation во время commit: он сначала упал на старом наследовании, затем прошёл после исправления. Это изменение не меняет sync-протокол и не разрешает чтение из карантина.

**Фактическая особенность Realtime:** уже открытая подписка с закэшированным разрешением получила одно новое событие маршрутизации после revoke. Payload содержал только `table`, `operation` и технический `id`; бизнес-поля отсутствовали. Проверка не выдаёт это за мгновенное серверное отключение подписки. После повторного join/обновления авторизации доступ закрыт, а RLS/RPC запрещают получение новых строк немедленно. Клиентская обработка permission invalidation, ACL quarantine и закрытие каналов при смене аккаунта сохраняются.

## 6. Пароли и Supabase Free

[Официальная документация](https://supabase.com/docs/guides/auth/password-security) по-прежнему ограничивает встроенную leaked-password protection тарифом Pro+. Тариф и настройки hosted Auth не изменены. Клиентская проверка не объявляется заменой серверной защиты.

Реализованы безопасные русские сообщения для `weak_password` и причин `pwned`, `length`, `characters`; неизвестные причины получают нейтральный текст. Сырой внутренний текст сервера не показывается. Reset-password теперь сохраняет полезную классификацию серверной ошибки.

Успешный `signInWithPassword` с `data.weakPassword` остаётся успешным: в приложении показывается уведомление со ссылкой на смену пароля. Оно привязано к аккаунту и попытке auth; поздний ответ от старой попытки/аккаунта не переносит предупреждение в другую сессию. Успешная смена пароля очищает предупреждение; неуспешная его сохраняет.

Настоящий GoTrue проверен с синтетическим legacy-паролем при сохранённой строгой политике Auth: signup/update слабого пароля отклоняются, существующий слабый пароль позволяет войти и возвращает weakPassword, сессия сохраняется, сильный update и последующий вход работают. Причина `pwned` проверена программными/UI-тестами; реальная HIBP-проверка hosted Free не включалась.

## 7. Выполненные проверки и границы доказательств

| Набор | Фактический результат |
| --- | --- |
| `npm test` | check:db, TypeScript, lint; 651 тест в 57 файлах — PASS |
| SQL suites | 15 различных сьютов; выполнены на 17.6 и 17.11 — PASS |
| Adversarial Data API | 57 исходных RPC; 646 проверок на одну комбинацию линии/версии |
| Комбинации API | fresh + hosted upgrade на 17.6 и 17.11: 4 × 646 = 2584 проверки — PASS |
| Конкурентность внутри API-матрицы | 70 на комбинацию; это подмножество 646, не дополнительные тесты |
| Template locking и deadline Data API/worker | Положительные/отрицательные роли, CAS, fanout, worker dedupe — PASS |
| Настоящий pg_cron | Регистрация job и реальная фоновая доставка без приложения, без дубля — PASS на обеих версиях |
| Auth / Data API / Broadcast | Реальный GoTrue, PostgREST и Realtime — PASS на обеих версиях |
| Backend integration runners | 6 различных scripts × 2 версии PostgreSQL = 12 успешных запусков, 0 неуспешных в итоговом наборе |
| Web/native PKCE | Реальные письма Mailpit, callback, обмен code, recovery/update/login — PASS на обеих версиях |
| Bootstrap HTTP | 15 datasets × 10 rounds = 150 отдельных страниц; 12 manifest и 152 page-запроса с mutation/conflict/recovery — PASS на обеих версиях |
| Исторические concurrency regressions | Двухсессионный набор — PASS на обеих версиях |
| Новая Realtime lifecycle-проверка | 5 групп — PASS; cached routing event после revoke явно зафиксирован |
| Fresh/hosted convergence и повтор семи файлов | PASS; две документированные trigger-ACL особенности сохранены |
| Реальный CLI deployment rehearsal | Только 7 pending; isolated apply, 72 history rows, следующий dry-run пуст; живой API reload — PASS |
| 17.6 → 17.11 backup/restore | Schema/ACL эквивалентны; checksum данных/audit/feed/receipts и повторный ACK совпадают — PASS |
| Android/iOS | Два production Hermes export — PASS; физические устройства не тестировались |
| Production web export | `npm run build:web` после браузерных проверок — PASS; `dist` восстановлен с обычной конфигурацией проекта |
| Браузер: дедлайны | PASS; реальные RPC/БД, UI fixture с синтетической Auth, desktop/mobile и прерывание/reconnect |
| Браузер: Account Offline | PASS после исправления гонки кеша; 26 контрольных точек, реальная Auth/Realtime, IndexedDB, Basic/Extended, офлайн-записи и reconnect |
| Браузер: Phase 6 | PASS после исправления гонки кеша; 8 контрольных точек: offline/F5/reconnect, conflict, kill switch, multitab, SW update и явный retry после revoke |
| Браузер: новый пароль | PASS; реальный GoTrue, успешный weak-password login, сохранённая сессия, banner при ширинах 320/390/768/1200, переход к форме, смена пароля, снятие banner и новый вход; 0 uncaught errors |

Итоговые результаты: **651 unit tests, 15 SQL suites на каждой версии, 2584 API checks и 4 браузерных набора прошли; в итоговых завершённых прогонах — 0 неуспешных проверок.** Это раздельные категории, а не суммируемое число уникальных тестов. У Account Offline и Phase 6 количество контрольных точек не включает строку общего успешного завершения runner.

Число SQL assertion не приравнивается к числу SQL-сьютов. 2584 — количество записанных логических проверок, а не число HTTP-запросов: некоторые проверки выполняют несколько запросов и сравнение всех хранилищ побочных эффектов. Отказанные операции сравнивают бизнес-таблицы, audit, item actions, notifications, receipts, sync feed, deadline state, runtime config, retention и синтетическую `auth.users`; легальный quota-counter вынесен отдельно.

Записанные результаты всех четырёх API-прогонов, итоговые числа, SHA новых миграций, manifest hosted history, backup/restore result и результаты браузерных проверок находятся в `docs/security-hardening-evidence/`. `summary.json` различает сгруппированные Advisor-категории и суммарное число замечаний. `browser-results.json` сохраняет контрольные точки и hashes полных логов трёх завершающих браузерных прогонов; `password-browser.json` — результаты настоящего password flow.

В матрице для каждой RPC проверены anon, service, неподдерживаемый actor-параметр и невалидный JSON. Для применимых сигнатур — NULL, чужие UUID, недостаточная роль, архивное/обратное lifecycle-состояние. Self/global RPC сохраняют документированный глобальный или собственный scope; отсутствие аргументов/объекта не подменяется выдуманным NULL/archive-тестом. Все 57 имеют реальные конкурентные и разрешённые вызовы.

Прогоны не являются доказательством отсутствия всех возможных уязвимостей. Hosted acceptance, реальные пользовательские сессии, managed upgrade и физические Android/iOS не выполнялись. Непройденные ранние запуски стенда (ACL владельца fixture, CORS, абсолютные локальные mail links и ограничения старых browser-helper на порт) исправлены в harness; успешными считаются только завершившиеся повторные проверки. Известных незакрытых продуктовых падений в перечисленных PASS нет.

Ранний password browser run прошёл UI-операции, но упал на завершающем SDK-запросе: синхронный browser-driver задерживал обработку закрытия idle-соединения Node. Исправлен только transport verifier в тесте, затем весь сценарий повторён успешно. Обнаруженная продуктовая гонка кеша и её отдельное исправление описаны в разделе 5. Эти ранние неуспешные запуски не включены в итоговые PASS и не скрываются общим числом 0.

## 8. Что остаётся в Advisor

| Тип | Hosted сейчас | Изолированная схема после изменений | Обоснование |
| --- | ---: | ---: | --- |
| Authenticated SECURITY DEFINER | 57 WARN | 56 WARN | RPC-only запись, membership/RLS и закрытые таблицы требуют контролируемого владельца. Alias стал INVOKER; остальные privilege boundaries сохранены |
| Mutable search_path | 2 WARN | 0 | Две trigger-функции исправлены и attachment сохранены |
| Leaked password protection | 1 WARN | SQL Advisor не проверяет hosted Auth | Free; требует отдельного решения по тарифу/серверной настройке |
| RLS without policy | 7 INFO | 8 INFO | Семь прежних RPC-only таблиц и новая закрытая таблица квоты |
| SECURITY ERROR | 0 | 0 | По выполненному Advisor и матрице |

Ожидаемый hosted результат после отдельного применения SQL: **57 WARN** (56 SD + 1 Auth) и **8 INFO**, если настройки Auth останутся прежними. Это прогноз по проверенной схеме; текущий hosted Advisor не менялся и по-прежнему содержит 60 WARN / 7 INFO.

Семь исходных INFO: `private.checklist_deadline_state`, `private.client_operation_receipts`, `private.offline_runtime_config`, `private.task_item_sync_changes`, `private.task_item_sync_retention`, `public.task_templates`, `public.task_template_items`. Прямой клиентский доступ закрыт; SD/RPC работают. Разрешающие политики ради исчезновения INFO не добавлялись.

Сохранённые SD остаются границами привилегий: ошибка в будущей проверке actor/role/lifecycle может стать уязвимостью, поэтому новые изменения этих функций требуют таких же отрицательных и конкурентных тестов. Текущий WARN сам по себе не доказывает обход авторизации. Отсутствие leaked-password protection оставляет реальный риск входа с известным скомпрометированным паролем; клиентское уведомление его не устраняет. Для встроенной серверной защиты нужно отдельное решение владельца по Pro+ и настройке Auth. INFO у закрытых RPC-only таблиц допустимы при сохранении запрета прямого доступа и проверок внутри RPC.

## 9. Воспроизведение

Требуются уже запущенный локальный Supabase/Docker, Node, зависимости проекта и Chromium для browser smoke. Test runners не сбрасывают общую БД. Новые API-results по умолчанию записываются в игнорируемую `.expo/security-evidence`; можно задать `TASKTRACE_SECURITY_EVIDENCE`.

```powershell
npm test
npm run test:sql:isolated -- --advisors --cron --generate-types
npm run test:security
npm run test:backend:isolated
node scripts/verify-security-convergence.mjs
node scripts/run-security-integrations.mjs scripts/security-realtime-lifecycle.mjs
node scripts/run-security-integrations.mjs scripts/account-offline-browser-smoke.mjs scripts/phase6-browser-smoke.mjs scripts/password-security-browser-smoke.mjs
node scripts/run-audit-sql-tests.mjs --browser
node scripts/test-security-postgres-upgrade.mjs
npx expo export --platform android --platform ios --output-dir .expo/security-native-export --clear
```

Для 17.11 runner использует закреплённый образ; при отсутствии его следует сначала получить `docker pull public.ecr.aws/supabase/postgres:17.11.0.004`. Временные DB/контейнеры удаляются в finally, включая replication slots только своей удаляемой БД. Браузерные сборки направляются на временный API через process env; `.env` и production-флаги не меняются.

## 10. Контролируемое применение SQL

До применения нужны отдельное подтверждение, свежая проверка hosted schema/history, резервная копия с проверенным восстановлением и окно обслуживания. Важны зависимости lookup RPC, отсутствие внешних service RPC consumers, поведение API transaction preferences и размеры таблиц/время создания недостающих индексов. `lock_timeout=3s` ограничивает ожидание DDL-lock; это не обещание отсутствия блокировок во время DDL.

Не запускать обычный `db push --include-all` из основной истории Git. Он может предложить старые локальные версии, уже реализованные в hosted другой историей.

Подготовлен offline deployment plan: временная CLI-директория содержит 65 **фактических** hosted-history файлов и семь новых файлов. Основные 66 исторических Git-файлов при этом не меняются. Это deployment-artifact для существующего проекта; для fresh install используется каноническая история репозитория.

1. Повторно считать фактические `version/name/statements` и schema snapshot. При drift остановить применение и пересравнить; старый план не использовать автоматически.
2. Построить новый план `prepare-security-deploy-plan.mjs <captured-history.json> <new-plan-directory>`. Manifest содержит SHA256 baseline и каждого файла.
3. После отдельного подтверждения выполнить CLI dry-run в этой временной директории с закрытым DB URL. **Pending должны быть ровно семь новых файлов и никаких baseline-файлов.** Любое другое предложение блокирует применение.
4. Применить эти семь файлов в порядке таблицы миграций. Production connection должна работать как `postgres` и иметь доступ к migration history. Текущий hosted каталог подтверждает такие права.
5. Проверить историю (65+7), каталог против проверенной canonical hosted-lineage схемы, ACL/default probes, Advisor, cache reload, квоту на отдельной разрешённой синтетической fixture, роли, template reorder/copy, offline replay, private topics, cron/deadlines и Auth. Эти production acceptance-проверки ещё не выполнялись.

Offline-план проверен настоящим Supabase CLI 2.116.0 в отдельной БД: dry-run предложил ровно семь, apply записал только их, следующий dry-run был пуст, каталог совпал с проверенной схемой. Это не применение к hosted.

### Восстановление при ошибке SQL

Не включать прежние опасные grants/defaults автоматически. При lock timeout проверить, что транзакция откатилась, пересчитать catalog/history и повторить в подходящем окне. Если файл уже записан в history, не имитировать его отсутствие repair-командой.

Проблему после частичного применения набора исправлять отдельной проверенной forward-миграцией либо восстановлением проверенной резервной копии в изоляции с контролируемым переключением. Не возвращать старый swap с несовместимым UNIQUE. При необходимости отката lookup необходимо согласовать его return type, API reload и SQL-потребителей. Любой rollback production остаётся отдельным подтверждаемым действием.

## 11. План обновления PostgreSQL

[Changelog Supabase от 25.09.2026](https://supabase.com/changelog?types=breaking-change) объявляет 17.6 → 17.11 и пять security cycles, 44 исправленных CVE в совокупности. Это не доказательство применимости всех CVE к данному проекту. Установленный hosted build 17.6.1.171 не позволяет по одной строке версии достоверно установить наличие каждого backport. Подтверждения поставщика по backport этого build не получено; ручная замена PostgreSQL в managed-проекте не выполняется.

Установлены `plpgsql`, `pg_stat_statements`, `pgcrypto`, `supabase_vault`, `uuid-ossp`, `pg_cron`. `ltree`, `btree_gist` и пользовательские selectivity estimators не обнаружены. Исходники приложения используют pgcrypto для стандартных UUID/служебных нужд; PGP legacy cipher операций приложения не найдено. Содержимое Vault и чужие зашифрованные данные не расшифровывались; их владельцы должны отдельно подтвердить отсутствие зависимости от legacy PGP BF/CAST5.

Проверенный Auth bcrypt через `crypt(..., gen_salt('bf'))` не является legacy PGP `cipher-algo=bf`; вход на 17.11 проверен реальным GoTrue.

Порядок отдельного upgrade:

1. В Dashboard проверить доступный именно этому проекту target, предупреждения eligibility, downtime и provider compatibility согласно [managed upgrade procedure](https://supabase.com/docs/guides/platform/upgrading); при неясности запросить Supabase о backport/GA target. Выполнена read-only попытка открыть General settings этого проекта: Dashboard перенаправил на вход, активной авторизованной браузерной сессии нет. Подключённый API не сообщает per-project upgrade eligibility. Нужна проверка владельцем в авторизованном Dashboard; eligibility не объявляется подтверждённой.
2. Снять защищённые DB/schema/roles backups и необходимые отдельные Storage backups; проверить восстановление. Free нельзя считать обеспеченным доступными платными daily backups; [документация backups](https://supabase.com/docs/guides/platform/backups) описывает границы DB/Storage и Free export. В задании проверено восстановление **синтетической** БД, не production backup.
3. Перед upgrade проверить фактические версии расширений, custom operators, `ltree`/`btree_gist` indexes, использование legacy PGP и custom MD5 role passwords. Обеспечить разрешённый output plugin `pgoutput` для Realtime согласно новой версии.
4. В согласованное окно выполнить управляемый upgrade через Dashboard после отдельного подтверждения. Документация указывает обновление Free при restore paused-проекта; pause/restore не запускать как скрытый обход approval.
5. Проверить version/build, extension versions, Auth/PKCE, PostgREST cache/API, RLS/RPC, Realtime reconnect/revoke, cron, deadlines, уведомления, CAS, ACK, pull retention/reset и браузерные offline Basic/Extended. Контролировать ошибки и длительные запросы. Условия output plugins, reindex и crypto приведены в [PostgreSQL 17.11 release notes](https://www.postgresql.org/docs/17/release-17-11.html); reindex/re-encryption выполнять только при подтверждённом обнаружении затронутых объектов и отдельном плане.
6. При сбое восстановить проверенную копию в отдельную среду и согласовать переключение; downgrade бинарников поверх изменённого managed volume не является планом восстановления.

Локальная совместимость 17.11 проверена SQL/API/Auth/Realtime/cron и backup restore; managed eligibility, platform rollout и production recovery остаются внешними условиями.

## 12. Условия готовности и незавершённые внешние действия

**READY WITH CONDITIONS** относится к подготовленному набору исходников и forward-миграций. Перед production необходимо:

* Получить отдельное подтверждение применения SQL и независимо — PostgreSQL upgrade/допустимого downtime.
* Пересверить schema/history, hashes и только семь pending файлов; подтвердить ownership/права history и отсутствие неожиданных SQL-зависимостей lookup и внешних service RPC consumers.
* Подтвердить commit/no rollback override в hosted PostgREST, проверяемую резервную копию и окно DDL.
* Выполнить отдельную production acceptance после применения, включая реальный Advisor и выделенную разрешённую fixture.
* Для upgrade проверить per-project eligibility/GA build и восстановление production backup. Определённые backport для текущего build не подтверждены.
* Встроенная Supabase HIBP-защита на Free недоступна; решение по Pro+/настройке принимает владелец. Изменения тарифа не выполнялись.

Физические устройства, hosted acceptance и managed upgrade не выдаются за выполненные проверки. Дальнейшие действия не требуют ослабления RLS, удаления нужных SD или изменения существующего offline-протокола.
