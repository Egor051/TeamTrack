# Исправления аудита B01–B07, P02–P05

Реализация начата 22 октября, итоговая проверка завершена 23 октября 2026 года, UTC+3.
Область: 11 указанных проблем. P01 исключена. Production, удалённая инфраструктура и пользовательские данные не изменялись. Commit, push, deploy и staging не выполнялись.

## 1. Общая сводка

- Реализованы все **11 исправлений**; все проверены локально соответствующими unit, SQL, HTTP или браузерными сценариями. Незавершённых реализаций: **0**.
- Изменены **37 файлов**: 26 существующих и 11 новых, включая этот отчёт. Исходных пользовательских изменений не было.
- Созданы **3 новые миграции**; исторические миграции не изменялись.
- Unit: **884 PASS**, 77 файлов; исходно 865 тестов. Добавлено **19 сценариев**, изменены 6 существующих unit-файлов и добавлены 2 новых.
- Добавлены 1 SQL-набор, HTTP-набор с 11 сценариями fresh/upgrade и браузерный набор. Расширены существующие PWA-тесты и изолированные тестовые адаптеры.
- Зависимости, package.json и package-lock.json не менялись.
- Вердикт: **COMPLETE WITH CONDITIONS**. Необходимы измеренная настройка бюджета до применения соответствующей миграции, отдельное решение по результатам dependency audit и проверки на физических устройствах. Проверенные экспорты и browser descriptors не заменяют приёмку Android/iOS.

## 2. Результаты по проблемам

### B01 — повтор отклонённого добавления участника

**Исправлено и проверено.** Квитанция сохраняла JSON-результат, но теряла HTTP-статус вложенного RPC. Повтор сохранённого отказа возвращался как HTTP 200.

Новый внутренний формат сохраняет `format_version`, исходный `value`, `http_status` и абсолютный срок разрешённого `Retry-After`. Повтор восстанавливает статус; срок ожидания уменьшается, а не начинается заново. Для исторических квитанций `TT_MEMBER_LOOKUP`/`PT429` восстанавливаются статусы 400/429. Отсутствующие в старом формате заголовки не выдумываются. В клиенте окончательный lookup-отказ завершает действие, а транспортная неопределённость сохраняет UUID. Функции добавления участника дополнительно отвергают отказ в теле успешного ответа.

Файлы: [SQL](C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261022201149_audit_rpc_outcomes.sql), [mutation.ts](C:/Users/chupa/proj/TeamTrack/src/lib/supabase/mutation.ts), [projects.ts](C:/Users/chupa/proj/TeamTrack/src/features/projects/projects.ts).

Результат: реальные PostgREST 400/429 на первом вызове и повторе, одинаковое тело, отсутствие повторного списания квоты, совместимость старого формата после upgrade. Браузер: потеря ответа реального отказа → повтор с прежним UUID → видимый отказ, форма и идентификатор пользователя сохранены, сообщения об успехе нет.

### B02 — повтор массового прочтения

**Исправлено и проверено.** Оптимистическое подтверждение всего текущего списка переносило результат прежней операции на уведомления, появившиеся после её commit.

Массовое действие теперь ожидает RPC и авторитетное чтение сервера. Результат RPC отделён от ошибки последующего чтения. Одиночные отметки остаются оптимистическими. Обновление учитывает актуальные фильтры, поколение запроса и эпоху аккаунта; состояние экрана разделено по аккаунтам. Частичная страница не записывается поверх Extended-окна.

Файлы: [экран](C:/Users/chupa/proj/TeamTrack/src/app/(app)/notifications.tsx), [чтение уведомлений](C:/Users/chupa/proj/TeamTrack/src/features/notifications/notifications.ts).

Результат: в настоящем UI ответ выполненной операции потерян, добавлено новое уведомление, страница перезагружена, прежний UUID повторён. Новое уведомление остаётся непрочитанным в БД и UI; следующее отдельное действие получает новый UUID и читает его. Unit дополнительно меняет фильтры во время RPC.

### B03 — пропуски в большом чек-листе

**Исправлено и проверено.** Независимые offset-страницы обычного UI не образовывали согласованный набор.

Оба пути `listTaskItems` и `ChecklistLocalRepository.refreshTaskItems` используют существующий `readSnapshotPages`: проверка revision, total, offset, уникальности, полноты и ограниченное число полных повторов при PT409. Существующие cache/ACL/account guards, условный commit и наложение pending operations сохранены.

Файлы: [projects.ts](C:/Users/chupa/proj/TeamTrack/src/features/projects/projects.ts), [repository.ts](C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/repository.ts).

Результат: реальный repository и публичный reader с sync ON/OFF проходят конкурентное удаление/архивацию между страницами без потери последнего элемента. SQL/HTTP проверяет 501 элемент; браузерный сценарий соединяет настоящий UI, HTTP-снимок, изменение между страницами и IndexedDB. Несогласованная страница отвергается с PT409, итоговый набор полон и уникален. Старые offline/cache/race-тесты проходят.

### B04 — чужие изменения инвалидируют снимок

**Исправлено и проверено.** Ревизия снимка зависела от максимального глобального курсора, включая чужие этапы и удаление истории.

Добавлена закрытая таблица `private.task_item_snapshot_revisions`. Триггер использует существующий feed cursor и атомарно обновляет ревизии затронутых этапов; очистка feed не снижает сохранённую ревизию. Backfill выполняется при блокировке writers. Relation lock берётся перед advisory lock в порядке существующего DML. Публичная сигнатура и проверки `has_task_access` сохранены; глобальный pull-протокол не меняется.

Файл: [миграция ревизий](C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261022201114_audit_task_snapshot_revision.sql).

Результат: изменение другого этапа не меняет revision целевого, изменение целевого вызывает PT409, очистка feed сохраняет revision. Проверены пустой этап, rollback изменения вместе с revision, режим active/all и запрет outsider. Fresh и upgrade проходят.

### B05 — HTTP 502/503 обходят PWA-fallback

**Исправлено и проверено.** Workbox NetworkOnly считал HTTP-ответ успешным, поэтому fallback не вызывался.

502/503 направляются в существующий precache fallback. Порядок опций generateSW обеспечивает вызов fallback перед заключительным обработчиком. Если оболочки нет, возвращается исходный 502/503. Таймаут тела/навигации, abort и границы app navigation сохранены.

Файлы: [генератор](C:/Users/chupa/proj/TeamTrack/scripts/generate-service-worker.mjs), [PWA browser test](C:/Users/chupa/proj/TeamTrack/scripts/pwa-mobile-browser-smoke.mjs).

Результат: проверен именно сгенерированный `dist/sw.js` в Chromium и WebKit. 502/503 показывают оболочку; 401/403/404 не подменяются. Пройдены разрыв соединения, зависание навигации/тела, обновление worker и отсутствие оболочки. Восстановление зависшей навигации — около 5,1–5,4 с в локальном тесте. Физические устройства не проверялись.

### B06 — конфликт редактора профиля

**Исправлено и проверено.** После PT409 оставался старый baseline, поэтому повтор не мог разрешить конфликт.

Используется существующий `useTextDraft`: черновик сохраняется, актуальный профиль читается с сервера, конфликт отображается, baseline меняется только после явного «Продолжить с моим черновиком». Автосохранения нет. Обработаны повторный конфликт, неудачное чтение, потеря ответа, эпохи A → B → A и поздние результаты. Явные операции профиля отменяются при смене аккаунта и защищены от фонового cache echo/обновления сеанса в том же аккаунте.

Файлы: [экран](C:/Users/chupa/proj/TeamTrack/src/app/(app)/profile.tsx), [AuthProvider](C:/Users/chupa/proj/TeamTrack/src/features/auth/AuthProvider.tsx).

Результат: реальный UI дважды получает конфликт, сохраняет черновик, явно согласует его и успешно сохраняет. Отказ по бюджету оставляет черновик и UUID; после восстановления бюджета повтор проходит. Потерянный ответ согласуется через ту же квитанцию. Provider-тесты проверяют смену аккаунта, ABA, неудачный refresh и cache/session echo во время записи.

### B07 — бесконечное откладывание обновления

**Исправлено и проверено.** Каждый новый event перезапускал debounce-таймер.

Окно 150 мс начинается первым событием и не продлевается. Выполняется один callback, события во время запроса сохраняют dirty/urgent, после завершения запускается необходимое обновление. Синхронное исключение и rejected Promise освобождают scheduler; dispose запрещает новые запуски. Асинхронный callback подписки уведомлений теперь ожидается.

Файлы: [scheduler](C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/refresh-scheduler.ts), [подписка](C:/Users/chupa/proj/TeamTrack/src/features/notifications/notifications.ts).

Результат: непрерывные 300 событий через 100 мс больше не дают ноль обновлений; проверены отсутствие параллельных запусков, dirty, urgent, ошибки и dispose. Polling не добавлялся.

### P02 — бюджет квитанций

**Реализовано и локально проверено; настройка перед эксплуатацией обязательна.** Бессрочные квитанции сохраняли полные аргументы и не имели admission limits.

В закрытых таблицах добавлены единая конфигурация лимитов и счётчики по аккаунту. Резервирование количества и логических байтов происходит под блокировкой аккаунта до бизнес-действия. Контролируются размер входа, максимальный результат и скорость новых операций. Квитанция сначала ищется повторно после ожидания блокировки: завершённый UUID повторяется и при полном/не настроенном бюджете. Превышение размера результата откатывает всё действие. Конфликт CAS освобождает квитанцию и её резерв. Завершённые результаты и UUID не удаляются и не меняются.

Аргументы компактируются в версионированный SHA-256 от типа, target и канонизированного JSONB. Сохраняются равенство чисел `1 = 1.0`, независимость порядка ключей, различие null/отсутствия и порядок массивов. Для generic RPC отпечаток включает весь объект аргументов; существующая семантика payload outbox-протокола сохранена. Результат и HTTP-семантика остаются в квитанции. Старые квитанции backfill-ятся без удаления результата.

Файлы: [миграция](C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261022202128_audit_receipt_budgets.sql), [retry handle](C:/Users/chupa/proj/TeamTrack/src/lib/supabase/mutation.ts), [сообщения](C:/Users/chupa/proj/TeamTrack/src/lib/errors/user-message.ts).

Результат: заполненное количество/объём, unconfigured policy, oversized request/result, rate limit, mismatch, CAS rollback, два запроса на последнее место и одинаковые конкурентные UUID проверены через PostgreSQL/PostgREST. Unit проверяет сохранение direct intent и outbox pending-цепочки без немедленного повтора; после восстановления ёмкости используется тот же UUID. B01 отказ успешно повторяется после компактирования и при заполненном бюджете.

**Существенное решение:** production-значения не угаданы. Все пять полей policy по умолчанию NULL: новые receipt-backed операции получают PT503/TT_RECEIPT_POLICY до настройки, старые квитанции повторяются. Это явное условие применения миграции. Числа тестового fixture не являются рекомендацией для production.

### P03 — пробелы интеграционного покрытия

**Исправлено и проверено в доступном локальном окружении.** Добавлены проверки настоящих границ UI → client → HTTP → SQL, receipt → replay, snapshot → cache, Service Worker → browser. Моки остаются в узких unit-тестах, но не являются единственным доказательством серверной семантики.

Файлы: [HTTP](C:/Users/chupa/proj/TeamTrack/scripts/audit-fixes-integration.mjs), [браузер](C:/Users/chupa/proj/TeamTrack/scripts/audit-fixes-browser.mjs), [SQL](C:/Users/chupa/proj/TeamTrack/supabase/tests/audit_fixes_test.sql), два новых unit-файла и изменения существующих тестов.

До исправления воспроизводились 400 → 200 при replay, пропуск последнего пункта offset-ридером, starvation scheduler, ложная отметка нового уведомления и геометрическое обрезание статуса на 320 px. Проверки усиливались проверкой фактической bounding box: одного document.scrollWidth было недостаточно.

### P04 — ошибки разрушительных действий

**Исправлено и проверено.** Ошибка оставалась в странице под открытым ModalLayer.

Ошибка передаётся активному ConfirmDialog, связывается с сущностью, очищается при открытии/закрытии и не переносится между шаблоном и его пунктом. Busy и существующий ModalLayer сохранены. Ошибка последующего reload остаётся отдельной ошибкой списка после завершившегося действия.

Файлы: [проект](C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id].tsx), [этап/пункт](C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/tasks/[taskId].tsx), [шаблоны](C:/Users/chupa/proj/TeamTrack/src/app/(app)/templates.tsx).

Браузер проверяет отказ внутри 6 активных диалогов: архив проекта, окончательное удаление проекта/этапа/пункта, удаление шаблона/пункта шаблона. Отмена/повторное открытие очищают ошибку. HTTP fault injection используется для управляемого отказа; настоящие данные не удаляются.

### P05 — узкие таблицы прогресса

**Исправлено и проверено в браузере.** Фиксированные колонки выходили за ширину фактического контейнера.

При ширине контейнера менее 700 px используются компактные строки с переносом значений; широкое табличное представление сохранено. Номера этапов, порядок, title/status и вычисление дневного прогресса UTC+3 не менялись.

Файлы: [общая строка](C:/Users/chupa/proj/TeamTrack/src/features/projects/daily-progress-row.tsx), [проект](C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/progress.tsx), [этап](C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx).

Результат: 18 измерений геометрии двух страниц, ширины 320/360/390/768/1280 px, светлая/тёмная темы и CSS-масштаб 200%. Проверяются scrollWidth контейнера и bounding box статуса, включая длинное слово без пробелов. Скриншоты 320 px визуально проверены. Это браузерная геометрия, не физические устройства.

## 3. SQL и миграции

Порядок применения:

1. `20261022201114_audit_task_snapshot_revision.sql`: закрытая таблица revision, backfill, замена feed trigger function и snapshot RPC.
2. `20261022201149_audit_rpc_outcomes.sql`: новый внутренний envelope `execute_client_mutation`, совместимость старых отказов.
3. `20261022202128_audit_receipt_budgets.sql`: policy/budgets, канонизация/hash, backfill/компактирование receipts, admission/accounting trigger и замена private claim.

Все миграции транзакционные, с lock_timeout 5 s. Контракт публичных RPC и generated public types не изменился. RLS включена на новых закрытых таблицах; прямые права public/anon/authenticated/service_role отозваны. Изменяется только внутренний формат закрытых receipts и revision снимка; в полёте старый revision безопасно получает PT409 и перечитывается.

Fresh: все **81 миграция** применены, **18 SQL-наборов PASS**. Upgrade: **21 SQL-набор PASS**, включая прежние upgrade fixtures; отдельный HTTP-upgrade создаёт записи и квитанции 400/429 на старой схеме и затем применяет ровно 3 новые миграции. Повтор сохранённых отказов и существующие пункты сохраняются.

### Обязательная настройка P02

В `private.client_operation_policy` требуется задать положительные:

| Поле | Что ограничивает |
|---|---|
| max_receipts | число бессрочных квитанций на аккаунт |
| max_logical_bytes | логический размер квитанций и незавершённых резервов на аккаунт |
| max_request_bytes | размер JSONB аргументов до компактирования |
| max_result_bytes | резерв под результат и максимальный размер сохранённого envelope |
| new_per_minute | новые admissions одного аккаунта в минуту |

Результат должен помещаться в `max_result_bytes`; свободный остаток должен вмещать его консервативный резерв плюс metadata. Снижение лимитов ниже существующего использования блокирует новые операции, но не уничтожает квитанции и не мешает replay. Смена окна не очищает бессрочные count/bytes. Ограничение логических байтов не является измерением физических страниц PostgreSQL, WAL или MVCC bloat. Общая ёмкость зависит также от числа аккаунтов.

Перед настройкой нужны распределения размеров исходных receipts/результатов, темп новых операций, число активных аккаунтов, retention/SLA и запас диска. Для оценки на разрешённой копии можно использовать `client_operation_budgets`, `octet_length(result_payload::text)` и `pg_total_relation_size` таблицы/индексов. Не выполнять DDL/DML по этому отчёту автоматически. Реальная production-настройка в этой задаче не выполнялась и не подменяет исключённую P01.

Изолированный тестовый fixture: [receipt-test-policy.mjs](C:/Users/chupa/proj/TeamTrack/scripts/receipt-test-policy.mjs). Он применяется только тестовыми harness после создания disposable БД; его ёмкость предназначена для прохождения набора тестов.

## 4. Проверки и доказательства

Артефакты расположены в `C:/Users/chupa/proj/TeamTrack/.expo/`; это игнорируемые локальные результаты, в Git не добавлены.

| Проверка | Результат | Количество | Ошибки | Ограничения / evidence |
|---|---|---:|---|---|
| TypeScript | PASS | весь проект | 0 | audit-typecheck.log |
| Штатный ESLint | PASS | expo lint | 0 | audit-project-lint.log |
| ESLint новых/затронутых тестов | PASS | 8 файлов | 0 | audit-new-tests-lint.log |
| Unit | PASS | 884 / 77 файлов | 0 | audit-unit-results.log |
| SQL fresh | PASS | 81 миграция, 18 наборов | 0 | audit-sql-fresh.log |
| SQL upgrade | PASS | 81 миграция, 21 набор | 0 | audit-sql-upgrade.log |
| Новые HTTP-контракты | PASS | 11 fresh + 11 upgrade | 0 | audit-http-fresh.log, audit-http-upgrade.log |
| Backend/Auth/PKCE/concurrency/bootstrap/Realtime | PASS | 7 программ | 0 | audit-backend-full.log; bootstrap 15 datasets, 150 отдельных HTTP-страниц |
| Security API fresh | PASS | 57 RPC, 674 сценария; 70 concurrency внутри этого числа | 0 | audit-security.log; security-evidence/security-api-results-fresh.json |
| Security API reconstructed upgrade | PASS | 57 RPC, 674 сценария; 70 concurrency | 0 | audit-security-upgrade-fixture.log; hosted в имени режима означает локальный fixture, не обращение к production |
| Official Security Advisor SQL | PASS с WARN/INFO | 1 изолированная БД | 0 ERROR | 74 WARN SECURITY DEFINER, 13 INFO RLS without policy; audit-sql-fresh.log |
| Новые UI regressions | PASS | 9 групп, включая 18 геометрий и 6 диалогов | 0 в итоговом прогоне | audit-browser-fixes-final.log; audit-fixes/results.json |
| Offline/Realtime существующий UI | PASS | 2 сценария | 0 | audit-browser-results.log; это исторические B01/B02 другого отчёта |
| Cross-tab mutation | PASS в двух повторных прогонах | 6 групп каждый | см. замечание ниже | audit-mutation-browser.log, audit-mutation-browser-repeat.log |
| Connectivity / outbox recovery | PASS | 6 сценариев | 0 | audit-browser-final.log; connectivity-recovery/results.json |
| Сгенерированный PWA worker | PASS | Chromium + WebKit | 0 | audit-pwa-results.log; offline, 502/503, 401/403/404, timeout, update, missing cache |
| Expo exports | PASS | Web, Android, iOS | 0 | audit-browser-fixes-final.log, audit-android-export.log, audit-ios-export.log |
| Физические Android/iOS | НЕ ВЫПОЛНЕНО | 0 | — | требуются реальные устройства |
| Production / hosted transport | НЕ ВЫПОЛНЕНО | 0 | — | запрещено изменять production; инфраструктура не проверялась заново |
| npm audit | FAIL | 20 findings: 18 HIGH, 2 MODERATE | exit 1 | audit-dependencies.json; lock/dependencies не менялись |
| git diff whitespace / secret scan | PASS | текущие изменения | 0 кандидатов | audit-final-review.json |

Команды для повторения безопасных проверок из корня workspace:

```text
npm run typecheck
npm run lint
npm run test:unit
node scripts/run-audit-sql-tests.mjs --fresh --advisors
node scripts/run-audit-sql-tests.mjs
node scripts/audit-fixes-integration.mjs
node scripts/audit-fixes-integration.mjs --upgrade
node scripts/test-security-hardening.mjs
node scripts/test-security-hardening.mjs --hosted
node scripts/run-security-integrations.mjs
node scripts/run-security-integrations.mjs scripts/audit-fixes-browser.mjs
node scripts/run-security-integrations.mjs scripts/connectivity-recovery-browser-smoke.mjs
node scripts/regression-mutation-browser.mjs
node scripts/pwa-mobile-browser-smoke.mjs
```

Все backend-команды создают `teamtrack_audit_<pid>` и loopback API с синтетическими пользователями/ключами. Основная локальная app-БД не мигрируется; production URL не используется. `--hosted` восстанавливает только сохранённое описание схемы в disposable БД. Native exports выполнялись с loopback-placeholder конфигурацией без доступа к backend.

Производительность проверена на затронутых механизмах: scheduler имеет фиксированное окно и один callback; receipt admission/replay использует PK и одну блокировку аккаунта; HTTP-набор на 501 элемент завершает проверки примерно за 6–448 мс на группу, включая вызовы fixture. Это не production load benchmark и не основание выбирать production-пороги. Миграционный backfill и аппаратная/масштабная нагрузка требуют измерений на разрешённой репрезентативной копии.

## 5. Найденные регрессии, ограничения и риски

- Исправлена обнаруженная при совместной проверке гонка B06: фоновый profile cache/session refresh отменял применение успешного сохранения того же аккаунта. Добавлен provider-тест; повторные реальные quota/lost-response/CAS сценарии проходят.
- Исправлено сохранение direct mutation UUID при TT_RECEIPT_LIMIT/RATE/POLICY: окончательный admission refusal теперь оставляет pending intent до ручного повтора. В outbox сохранены цепочка, UUID и существующий backoff; немедленного повторного цикла нет.
- Старые тестовые query adapters обновлены под реальный snapshot RPC. Старые проверки не удалялись. В новых тестах исправлены селекторы реального tab/accessibilityLabel и ожидание окончания запроса; assertions полноты, UUID и ошибок не ослаблялись.
- Один первый cross-tab прогон завершился отказом проверки закрытия вкладки; после добавления диагностического результата два полных повтора прошли без изменения соответствующего успешного пути протокола. Причина единичного сбоя не установлена; не считать этот факт доказательством отсутствия flakiness, наблюдать REG-01 в CI.
- Дополнительный общий `eslint src tests scripts` выявлял прежние нарушения в старых тестовых harness. Штатный lint проходит. Ошибки в затронутом profile test устранены; новые тесты проходят отдельный lint без подавлений. Общий дополнительный прогон не объявляется успешным.
- Свежий npm audit остаётся FAIL: 18 HIGH и 2 MODERATE. MODERATE относятся к Vitest/@vitest/mocker. Пакеты/lock неизменны; исправление зависимостей не входит в эти 11 проблем. Прежнее исключение dependency gate не переутверждалось и не выдаётся за чистый аудит.
- Требуются настройки всех пяти receipt limits до включения новых receipt-backed записей. До настройки новый RPC-вызов явно откажет, а не выполнит действие без квитанции.
- Требуются приёмка на физических устройствах и наблюдение после контролируемого выпуска: quota refusals, использование бюджета, длительность snapshot/retries, scheduler и profile conflicts. Никакие новые мониторы, cron или production-механизмы не создавались.
- P01 не реализована; разрешённые SQL-изменения ограничены B01/B04/P02.

## 6. Контроль репозитория

Исходный и конечный HEAD: `810f1a367b7d350b5e3ce1bb0b62f22093ba9049`.
Начальное дерево чистое. Итог: 26 modified, 11 untracked; staged-файлов нет. Всё перечисленное ниже относится к текущей задаче. Commit/push/deploy отсутствуют.

Изменённые файлы:

```text
C:/Users/chupa/proj/TeamTrack/scripts/generate-service-worker.mjs
C:/Users/chupa/proj/TeamTrack/scripts/pwa-mobile-browser-smoke.mjs
C:/Users/chupa/proj/TeamTrack/scripts/regression-mutation-browser.mjs
C:/Users/chupa/proj/TeamTrack/scripts/run-audit-sql-tests.mjs
C:/Users/chupa/proj/TeamTrack/scripts/security-test-harness.mjs
C:/Users/chupa/proj/TeamTrack/scripts/test-security-hardening.mjs
C:/Users/chupa/proj/TeamTrack/src/app/(app)/notifications.tsx
C:/Users/chupa/proj/TeamTrack/src/app/(app)/profile.tsx
C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id].tsx
C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/progress.tsx
C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/tasks/[taskId].tsx
C:/Users/chupa/proj/TeamTrack/src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx
C:/Users/chupa/proj/TeamTrack/src/app/(app)/templates.tsx
C:/Users/chupa/proj/TeamTrack/src/features/auth/AuthProvider.tsx
C:/Users/chupa/proj/TeamTrack/src/features/notifications/notifications.ts
C:/Users/chupa/proj/TeamTrack/src/features/projects/projects.ts
C:/Users/chupa/proj/TeamTrack/src/lib/errors/user-message.ts
C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/refresh-scheduler.ts
C:/Users/chupa/proj/TeamTrack/src/lib/local-cache/repository.ts
C:/Users/chupa/proj/TeamTrack/src/lib/supabase/mutation.ts
C:/Users/chupa/proj/TeamTrack/tests/offline-auth-profile.test.tsx
C:/Users/chupa/proj/TeamTrack/tests/offline-repository-races.test.ts
C:/Users/chupa/proj/TeamTrack/tests/offline-sync.test.ts
C:/Users/chupa/proj/TeamTrack/tests/online-mutation.test.ts
C:/Users/chupa/proj/TeamTrack/tests/read-refresh-scheduler.test.ts
C:/Users/chupa/proj/TeamTrack/tests/tasktrace-regressions.test.ts
```

Новые файлы:

```text
C:/Users/chupa/proj/TeamTrack/docs/audit-fixes-2026-10-22.md
C:/Users/chupa/proj/TeamTrack/scripts/audit-fixes-browser.mjs
C:/Users/chupa/proj/TeamTrack/scripts/audit-fixes-integration.mjs
C:/Users/chupa/proj/TeamTrack/scripts/receipt-test-policy.mjs
C:/Users/chupa/proj/TeamTrack/src/features/projects/daily-progress-row.tsx
C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261022201114_audit_task_snapshot_revision.sql
C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261022201149_audit_rpc_outcomes.sql
C:/Users/chupa/proj/TeamTrack/supabase/migrations/20261022202128_audit_receipt_budgets.sql
C:/Users/chupa/proj/TeamTrack/supabase/tests/audit_fixes_test.sql
C:/Users/chupa/proj/TeamTrack/tests/checklist-snapshot-reader.test.ts
C:/Users/chupa/proj/TeamTrack/tests/notification-bulk-retry.test.tsx
```

## 7. Вердикт

**COMPLETE WITH CONDITIONS.** Все 11 исправлений реализованы, совместимость проверена на изолированной БД и в браузерах. Незавершённых реализаций нет. Полная эксплуатационная готовность не подтверждается: нужен измеренный receipt budget, отдельное решение по npm audit, приёмка физических устройств и наблюдение единичной нестабильности cross-tab теста. Production не изменён, P01 исключена, публикации не было.
