# Реализация R01–R03 — 23 октября 2026

> Исторический отчёт. Его audit и временное exception описывают состояние на 23.10.2026 и не управляют текущим release decision. Текущие advisory, риск-реестр и результаты gate приведены в [security-risk-register-2026-10-29.md](security-risk-register-2026-10-29.md).

## 1. Общая сводка

Итог: **COMPLETE WITH CONDITIONS** для локальной реализации. Это не разрешение
production-релиза. P01 исключён. Production, hosted Supabase и реальные данные
пользователей не изменены; commit/push/deploy не выполнялись.

R01: реализованы серверный протокол v3, конечные окна admission/replay,
необратимые fences, ограниченные live-бюджеты и GC, legacy-cutover,
history-generation, durable online/offline handles, IDB/SQLite v6, новые IDs
при v3-rebase и явное согласование неопределённых исходов.

R02: Vitest и связанные mocker/spy обновлены до 5.0.3; несовместимые откаты
Expo/RN не применены. Последний audit остаётся FAIL с 4 HIGH от node-forge.
Предыдущие 18 HIGH сохранены как отдельное раннее свидетельство: advisory
braces был отозван upstream в течение выполнения задачи.

R03: исправлены Clock-harness, недостаточные barriers, классификация liveness
по общей блокировке аккаунта и гонка устаревшего lock snapshot закрывающейся
вкладки. Добавлены явные режимы new/retry. Причина первоначального исторического
отказа остаётся **не доказана**; исправленные классы воспроизведены отдельно.

<!-- SUMMARY-COUNTS:START -->
Изменено существовавших файлов: **34**; добавлено новых: **12** (46 файлов R01–R03).
С исходными 37 dirty files пересекаются 9; остальные 28 исходных dirty files побайтово сохранены.
Полное рабочее дерево: **51 modified + 23 untracked = 74**, staged 0.
Добавлены **2 миграции**, **27 unit cases** (884 → 911 в прежних 77 test files),
**1 SQL suite**, **30 HTTP acceptance cases** (fresh и upgrade), **4 browser/UI cases**,
crash/restore (3 проверки), load/GC и новые cross-tab ветки. Эти категории не суммируются
с повторными исполнениями одного сценария. Исправлено 11 функциональных/протокольных дефектов;
ошибки test fixtures/harness перечислены отдельно.
<!-- SUMMARY-COUNTS:END -->

Обнаруженные и исправленные дефекты перечислены в части 7. Условия приёмки:
измерить production-нагрузку и выбрать G/H/бюджеты/cutover; проверить restore
с внешним traffic fence и реальные Android/iOS; отдельно пересмотреть security
policy для изменённого дерева. Ни один из этих пунктов не подменён локальным PASS.

## 2. R01: архитектура, гарантии и доказательства

Полный фактический контракт и runbook: [client-operation-protocol-v3.md](client-operation-protocol-v3.md).

Namespace — `(generation, epoch, user_id, operation_id)`. Контекст выдаёт сервер.
Клиент сохраняет UUID/черновик перед запросом контекста и полный handle перед
первым business POST. В outbox контекст появляется только при первой отправке:
никогда не отправлявшийся многомесячный черновик не получает искусственно
истёкший namespace при enqueue.

В одной транзакции резервируются квитанция/бюджет, исполняется авторитетная
business-функция и сохраняется bounded outcome. Internal/Auth ошибки откатывают
всё; terminal validation/CAS outcomes обрабатываются явно. Повтор известного
ID не расходует новый слот и не выполняет business mutation. B01 HTTP 400/429,
Retry-After и существующий allowlist сохранены.

V3 fingerprint включает expected_version. Изменить payload или precondition
прежнего attempt нельзя. Согласованный CAS-rebase получает новые attempt IDs,
атомарно переписывает depends_on/conflict references и сохраняет logical ID.
Исторический v2 fingerprint по-прежнему исключает expected_version; legacy UUID
не переписываются. Pre-v2 неизвестные строки сохраняются для review.

Окно `open → replay_only → retired` закрывается под exclusive epoch fence после
дренирования admitted writers. Deadlines/state/floor не откатываются. На границе
deadline после ожидания budget lock возвращается window_closing, а не ложное
not_applied. Отдельная resolver-транзакция фиксирует закрытие. Удалённый receipt
не делает старый handle новым: retired descriptor либо monotonic floor запрещают
claim до business dispatch. При другом generation действует history_reset.

Бюджеты учитывают live receipt count и logical bytes на пользователя и глобально.
Есть отдельные request/result bounds и rate limit новых claims. Worst-case
result резервируется заранее, затем reservation уменьшается. Переполнение
результата откатывает effect и reservation. Replay известной квитанции работает
при полном бюджете. После retirement/cleanup слот снова допускает новые операции.

Cleaner удаляет bounded batch одного аккаунта под тем же порядком блокировок и
атомарно уменьшает counters. Прерывание не оставляет рассинхронизации. Пустые
account budgets/epoch descriptors исчезают; бессрочных per-operation tombstones
нет. Два cleaner-воркера сериализуются с exclusive epoch lock, без upgrade
shared→exclusive. DELETE освобождает logical admission, но не уменьшает heap-файл.

Текущие RLS/ACL проверяются при раскрытии чувствительного historical body, включая
legacy-resolver. После удаления сущности/отзыва доступа возвращается redacted
terminal state. Deleted Auth account со всё ещё валидным JWT не допускается.
Существующий audit FK препятствует hard-delete Auth fixture; тест проверяет
реальную Supabase soft-delete семантику deleted_at и не заявляет исправление FK.

IndexedDB/SQLite обновлены до v6 без очистки очереди/конфликтов. Полный handle
привязывается транзакционно, первая привязка выигрывает. Обе реальные storage
реализации проходят общий новый contract suite. Schema/type generation выполнен
по изолированной migrated БД, а не ручной заглушкой типов.

Expired/reset/redacted исходы переходят в review, сохраняют черновик и останавливают
автоматическую отправку этой цепочки. Существующий компактный индикатор показывает
черновик/актуальное разрешённое состояние и явный keep-server/acknowledge. Для
открытого unknown допускается только прежний handle, без свежего ID. Наличие
текущих данных не объявляется доказательством исторического исполнения. Реальные
CAS-конфликты сохраняют существующий ConflictGate; обычное expiry не создаёт
глобальную блокировку остальных задач.

Restore/PITR: внешний traffic fence → restore → privileged generation rotation
и commit → проверка отказа потерянным будущим handles → открытие API. PostgreSQL
не может самостоятельно узнать о потерянном будущем. Этот предел явно сохранён;
ротация без закрытия внешнего трафика не объявлена безопасной.

### Матрица 24 обязательных сценариев

Ниже фактические механизмы проверки, а не 24 условных unit-модели. Обозначения:
HTTP = operation-window-integration; browser = regression-mutation-browser;
UI = operation-window-ui-browser; crash = operation-window-crash;
load = operation-window-load; storage = общий contract IDB/SQLite.

| № | Сценарий | Проверка и граница доказательства |
| --- | --- | --- |
| 1 | Немедленный повтор | HTTP exact result, fingerprint, один effect/receipt |
| 2 | Lost ACK после commit | browser/реальный exported outbox: тот же ID, один effect |
| 3 | Через час | HTTP, управляемые реальные серверные часы, прежний результат |
| 4 | Через дни | HTTP после трёх дней: replay |
| 5 | Через месяцы | HTTP после 60 дней внутри H: replay |
| 6 | Через годы | HTTP через 10 лет: expired, без новой квитанции/effect |
| 7 | Долгий offline | storage: старый never-sent draft привязывается сейчас; UI: отправленный outbox после H сохраняет исходный handle и review |
| 8 | Переустановка | Чистый BrowserContext: retry без handle останавливается до POST; физический uninstall устройства не проверен |
| 9 | Потеря IndexedDB | Реальное deleteDatabase/reload: missing-handle retry не создаёт ID/effect |
| 10 | Несколько устройств | Независимые browser stores с перенесённым полным handle и два HTTP/CAS клиента; физические устройства не подменяются этим тестом |
| 11 | Две вкладки, одна операция | Реальные Web Locks/IDB/PostgREST; один UUID/receipt/effect |
| 12 | Разные одинаковые намерения | Два независимых вызова: разные IDs и два effects |
| 13 | Конкурентные изменения | Два v3 CAS attempts с одним precondition: applied + conflict, один version bump |
| 14 | Удаление сущности | Архивация + hard-delete item: receipt остаётся, replay redacted, нет resurrection |
| 15 | Отзыв доступа | v3 и legacy replay/resolver скрывают чувствительный body; новый claim запрещён |
| 16 | Изменённый payload | 22023, fingerprint/expected_version неизменяемы, effect не повторяется |
| 17 | Между исполнением и ACK | browser barriers до body/после commit, SQL visibility отдельным соединением |
| 18 | Крах PostgreSQL | Реальный Docker KILL до/после commit: совместный rollback/сохранение effect + receipt |
| 19 | Прерывание cleaner | Реальная транзакция DELETE/counters затем ROLLBACK; counters точно прежние |
| 20 | Retry во время cleanup | Параллельные HTTP replay/GC и два SQL cleaner: expired, без duplicate/deadlock |
| 21 | Рост пользователей/операций | 8 аккаунтов, 512 writes/replays, пять последующих epoch cycles; итоговые metadata/counters ограничены |
| 22 | Полный бюджет | Изолированный full budget: new admission denied, known replay survives; после GC новый claim succeeds |
| 23 | Backup | Реальный pg_dump/restore отдельной БД, API остановлен до rotation; lost-future handle rejected |
| 24 | Нет исторического результата | После GC старый handle expired, review/fresh read/явное решение; исторический успех не выдумывается |

Границы: физические mobile lifecycle/network условия, реальная длительность лет
и production-нагрузка не проверялись. Временные сценарии используют настоящий
PostgreSQL/PostgREST с управляемым лабораторным clock, не ожидание месяцев.

### Нагрузка

Финальный лабораторный замер: 512 операций, 8 пользователей, concurrency 16.
Claim p50/p95/p99 99.34/343.02/442.77 ms, replay 13.50/26.26/31.56 ms.
512 receipts: 167424 logical bytes, heap 286720, indexes 65536.
Cleanup 512 rows — 103 ms. Затем пять эпох по 32 операции: cleanup около
78–104 ms; в конце receipts=0, epochs=0,
user_budgets=0. PK lookup использует Index Scan.

Heap в конце 352256 bytes, dead tuples=842, autovacuum в коротком замере не успел
пройти. Cluster WAL около 4.41 MB включает фоновые действия общего local cluster;
его нельзя выдавать за attributable WAL на операцию. Это не production sizing.

## 3. R02: зависимости и security

| Пакет | Было | Стало |
| --- | --- | --- |
| vitest | 5.0.2 | 5.0.3 |
| @vitest/mocker | 5.0.2 | 5.0.3 |
| @vitest/spy | 5.0.2 | 5.0.3 |
| magic-string для Vitest | 1.4.2 | 1.4.3 |
| why-is-node-running | 3.2.2 | 3.2.1, exact requirement новой версии Vitest |

Другие package versions в lock не изменены. Vite остаётся 8.3.3, Rolldown 1.2.11,
OXC 0.151.0, Expo/RN/React/TypeScript прежние. Scoped override сохраняет совместимый
Rolldown magic-string 1.4.2, не навязывает его новому Vitest. Неудачные пробные
широкие overrides удалены. Итоговый lock сгенерирован npm; integrity не редактировались.
Diff package/lock: 10 и 48 строк соответственно. npm ls заканчивается exit 0.

Устранены [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)
и [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp).
Unit/exports/runtime проверки описаны в части 5, включая Node 22 и Node 24.

Отдельный финальный all-platform export с source maps и существующий
verifyBundles подтвердили отсутствие braces/node-forge среди sources Web,
Android и iOS client bundles. Это ограниченная проверка состава bundles;
она не отменяет tooling advisory и не разрешает security exception.

Ранний полный audit после обновления: 18 HIGH, 0 MODERATE, exit 1. Во время
финальной проверки [braces advisory был отозван 23 октября](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
upstream больше не считает его practically exploitable. Это изменение advisory,
а не результат исправления braces в этом diff. Бounded direct stack-exhaustion
probe не доказывает practical application exploit и не отменяет withdrawal.

Последний raw audit: **4 HIGH, 0 MODERATE, FAIL** — node-forge и его три dependency
parents (`@expo/code-signing-certificates`, Expo CLI, Expo).
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) затрагивает
node-forge ≤1.4.0; patched version отсутствует. Путь относится к tooling/certificate
verification. Клиентский production exploit/keyless forgery этим исследованием не
доказан; пакет не объявляется исправленным. Криптографический fork не создавался.

Raw reports сохранены отдельно. Security policy не переписана: прежнее исключение
ограничивалось hash/graph/expiry 2026-10-25T20:59Z; новое дерево и withdrawn advisory
требуют нового независимого review. Текущий gate **FAIL**, не clean audit и не
PASS WITH APPROVED EXCEPTION. Сетевой timeout первого повторного gate также сохранён.

## 4. R03: причины и эксперименты

Исходный исторический отказ — нестабильное восстановление операции в другой
вкладке после commit/lost ACK/закрытия владельца. Его первоначальные причины
не были доказаны предыдущим исследованием и здесь не объявляются установленными.

Подтверждены отдельные классы:

1. Общая account lock не доказывает, что именно эта операция выполняется.
   На baseline исходнике управляемый orphan + посторонняя account lock
   воспроизводит TT_MUTATION_RECONCILED. Operation-specific lock и явный retry
   устраняют этот сценарий.
2. locks.query — временной snapshot. В реальном текущем прогоне закрывающаяся
   вкладка ещё считалась владельцем при первоначальной классификации, а к моменту
   получения account fence уже исчезла. Повтор использовал прежний ID/один effect,
   но ошибочно сообщил RECONCILED. Теперь retained running envelope повторно
   оценивается под acquired account fence. Добавлен deterministic stale-snapshot
   тест и unit; проверки independent new intents сохранены.
3. Завершённый quota/Auth admission отказ мог оставить running на runtime без
   Locks.query. Node 22 раскрыл этот дефект; теперь сохраняется unknown.

В промежуточной 100-серии до явного retry был также отказ repeat-57-running.
Свидетельства: `.expo/r03/2026-10-23T12-38-28.662Z-14944/`.
Дополнительный closing-tab отказ до re-evaluation:
`.expo/r03/2026-10-23T18-24-05.951Z-27324/`.
Оба сохранены с SQL/receipt/effect/handle evidence; отказ не скрыт повторным запуском.

Harness использует отдельный context с Clock, установленным до navigation и
создания таймеров. Проверяется, что отменённый timer не срабатывает. Остальные
HTTP-сценарии используют реальное время. Barriers привязаны к HTTP hold, Web Lock
queue и независимому SQL commit visibility. Таймауты не увеличивались; assertions
не ослаблялись. Корреляция включает tab/request/op/generation/epoch/account,
snapshot locks, durable bindings/envelopes, response body и SQL receipt hash.
Диагностика записывается до закрытия браузера и удаления disposable БД.

Финальные Chromium и WebKit серии: **100 lost-ACK closure + 100 running-orphan
closure в каждом engine**, без автоматических test retries. Дополнительно:
первоначальные сценарии, stale snapshot, три pre-fetch/body close barriers,
потеря IDB, чистая установка, независимые browser stores с transferred handle
и полный restart browser process с persistent profile. Это не physical device
acceptance.

Классификация исходного исторического отказа: **UNCONFIRMED HISTORICAL CAUSE**.
Подтверждены и исправлены родственные классы и текущие реальные отказы; их нельзя
ретроспективно приписывать первоначальному эпизоду без недостающей трассы.

## 5. Тестирование

Все указанные здесь запуски выполнены в текущей задаче, baseline вынесен отдельно.
Артефакты: `C:\Users\chupa\AppData\Local\Temp\teamtrack-r01-r03-implementation-20261023`.

<!-- FINAL-TEST-TABLE:START -->
| Проверка | Результат | Количество | Ошибки | Ограничения |
| --- | --- | --- | --- | --- |
| Baseline unit | PASS, отдельно от новых PASS | 884 / 77 files | 0 | Исходное рабочее дерево |
| Unit Node 22.20.0 | PASS | 911 / 77 files | 0 в final | maxWorkers=1, отдельно от browser/build jobs, deadlines не увеличены; unit-isolated22.log |
| Unit Node 24.15.0 | PASS | 911 / 77 files | 0 в final | maxWorkers=1; unit-isolated24.log |
| TypeScript / ESLint | PASS | 2 команды | 0 | typecheck-delivered.log / lint-delivered.log |
| Fresh SQL + official advisor | PASS | 19 suites, 83 миграции | 0 ERROR | 81 WARN definer / 18 INFO private RLS, local only; sql-complete-fresh.log |
| Upgrade SQL + official advisor | PASS | 22 suites, 83 миграции | 0 ERROR | Реальные upgrade fixtures; sql-complete-upgrade.log |
| V3 PostgREST fresh/upgrade | PASS | 30 + 30 case executions | 0 | Реальный HTTP/SQL, controlled lab time; v3-complete-*.log |
| Hard crash / fenced backup restore | PASS | 3 | 0 | Собственный контейнер; intentional disconnects записаны отдельно; crash-observed.log |
| Load / live accounting / GC | PASS | 512 writes + replays, 8 users; 5 × 32 последующих writes | 0 | 16 concurrent; shared-cluster WAL не attributable; load-complete.log |
| IDB / SQLite storage contracts | PASS внутри unit | 7 + 7 новых cases | 0 | Реальные IDB API / Node SQLite adapter; не physical device |
| Chromium cross-tab | PASS | 100 lost-ACK + 100 running closures, отдельные дополнительные branches | 0 в final | Нет автоматических retries; cross-delivered-chromium.log |
| WebKit cross-tab | PASS | 100 + 100, те же дополнительные branches | 0 в final | Не physical Safari/iOS; cross-delivered-webkit.log |
| Expired online/offline review в exported app | PASS | 4, оба engines | 0 в final | Real HTTP proxy fault, light 1200 / dark 390; ui-accepted.log |
| PWA generated SW / fallback / explicit recovery / update | PASS | 3 последовательных запуска × 2 engines + финальный × 2 | 0 в final | Отдельно от сборки; pwa-accepted-1/2/3.log и pwa-delivered.log; не physical devices |
| Предыдущие B01–B07/P02–P05 HTTP | PASS | 11 fresh + 11 upgrade cases | 0 | prior-audit-integration.log / prior-audit-upgrade.log |
| Предыдущие app UI regressions | PASS | 9 groups | 0 в app group | app-browser-regressions-second.log: отдельный старый connectivity assertion далее падал и исправлен |
| Connectivity / real durable outbox | PASS | 6 scenarios | 0 в final | connectivity-final.log |
| Auth / Data API / Realtime / Mailpit backend | PASS | 7 scripts | 0 | backend-browser-full.log; local stack, не hosted |
| Security original RPC/access/races | PASS | 57 RPC / 610 matrix scenarios + race/quota groups | 0 | security-final.log, включая legacy resolver redaction |
| Web / Android / iOS exports | PASS | 3 platforms | 0 | build-delivered.log / export-*-delivered.log; сборки не physical acceptance |
| Клиентские source maps | PASS | Web + Android + iOS, 3 maps | braces/node-forge отсутствуют | bundle-proof.json; это не approved exception и не PASS всего security gate |
| npm ls | PASS | выбранное полное дерево и npm exit 0 | 0 | npm-ls-complete.log |
| npm audit raw | **FAIL** | **4 HIGH, 0 MODERATE** | node-forge + 3 parents | audit-full-latest.json; раньше в задаче 18 HIGH, braces затем withdrawn |
| Security policy gate | **FAIL** | 1 current-tree check | Lockfile changed: risk reassessment required | Старое исключение не обновлялось; gate-verified.log |
| Expo Doctor | **20/21, внешний FAIL** | 21 checks | React Native Directory: unexpected server response | expo-doctor-final.log; проверка внешних metadata недоступна |
| Whitespace / historical migration integrity / stage | PASS | diff check, исходные migration hashes, stage 0 | 0 | По baseline, без reset/stash/checkout |
<!-- FINAL-TEST-TABLE:END -->

Неудачные/промежуточные проверки и исправления:

- Node 22 full run при одновременной тяжёлой сборке/сериях: bootstrap timeout
  на 5000 ms и последующий сбой зависимого test fixture. Повторяется отдельным
  полным прогоном без увеличения deadline; это учитывается как нагрузочная
  нестабильность теста, а не скрывается.
- Raw security gate остаётся FAIL; первый сетевой повтор завершился timeout.
- SQL advisor download дважды не достиг GitHub по IPv6/IPv4. Официальный pinned
  SQL скачан отдельно и проверен SHA-256; final fresh/upgrade выполняют тот же
  advisor без сетевой зависимости. Его predicates не менялись.
- Старые browser quota/count assertions обращались к legacy policy/table;
  fault injection/count переведены на фактически используемые v3 объекты.
- Новая UI fixture сначала вызвала legacy update без CAS, затем неверно записывала
  out-of-line IDB store без ключа. Исправлены fixtureCas и точный durable key.
  Эти отказы не выдаются за ошибки бизнес-логики приложения.
- В WebKit page.route пропускал Service Worker mutation: ACK фактически доходил,
  очередь корректно очищалась. Fault injection перенесён в реальный HTTP proxy,
  который обрывает ответ строго после SQL commit и retirement, для обоих engines.
- PWA WebKit до явного initialRouteName иногда уходил в forgot-password после
  gateway fallback. После задания login прошли три последовательные серии и
  финальный запуск; прямой forgot-password также проверен.
- Промежуточная fixture нового review-restore case меняла id без handle.id;
  она исправлена, production-validator не ослаблен. Отказ сохранён в unit-delivered22.log.
- Первый hard-crash harness требовал проверки новой Docker port mapping и
  readonly schema-ready barrier после рестарта. Добавлены; бизнес-операция
  не ретраится тестовым harness ради получения PASS.

Не выполнены: hosted migration/deployment/production load, physical Android/iOS
install/crash/network/upgrade acceptance, воспроизведение самого первоначального
исторического эпизода с его недоступной трассой. Android/iOS exports и browser
descriptors не считаются physical validation. Отдельного cycle analyzer в
установленном проекте нет; импорты проверены TypeScript/ESLint/сборками.

## 6. SQL, миграции и эксплуатация

Новые миграции созданы через Supabase CLI:

- `20261023115036_operation_window_protocol.sql`;
- `20261023115657_operation_window_lifecycle.sql`.

Новые private tables: window_policy, history, epochs, live_budgets,
receipts_v3 с префиксом client_operation_. Новая private observability view
client_operation_lifecycle_status, immutable/monotonic triggers, claim/complete/
resolve/authorization/fence helpers и lifecycle/rotation functions. Public RPC
перечислены в protocol document.

Изменены только новые определения поверх предыдущего состояния: legacy
claim_client_operation получает единый fence/auth/privacy guard;
account_client_operation допускает GC completed legacy rows только после
retirement. Исходный dispatcher извлечён в private helper с прежним allowlist;
прямой client EXEC отозван. Старые миграции не редактировались.

Fresh: 19 SQL suites; upgrade: 22. Отдельный upgrade через настоящий PostgREST
сначала создаёт legacy generic denial и v2 outcome, затем применяет новые
миграции и проверяет точный UUID/result/status/fingerprint. Новый v3 контур
в обоих режимах проходит 30 acceptance checks. Official Security Advisor:
0 ERROR; существующие authenticated SECURITY DEFINER WARN и private RLS INFO
перечислены в логах и не объявлены отсутствующими.

Lifecycle: existing pg_cron convention, каждые 5 минут, batch 500, maximum 8 epochs,
top-level statement_timeout 20s; без установленного extension расписание не
создаётся. При нагрузке подтвердить достаточность cadence/batch и отсутствие
starvation/backlog. Default v3 policy NULL; перед production обязательно выбрать
G/H, per-account/global live count/bytes, request/result bounds, new-claim rate,
legacy cutoffs. Числа тестового policy — лабораторные, не production recommendation.

Для выпуска нужны отдельный schema/grant review и разрешение migrations,
server-first sequencing/configuration, достаточный retention/capacity headroom,
наблюдение GC/physical growth и traffic-fenced restore drill. Restore rotation
не заменяет внешний fence. Production не менялся.

## 7. Регрессии, риски и пределы гарантий

Исправлены одиннадцать функциональных/протокольных дефектов, обнаруженных при реализации:

1. Прежняя account-lock liveness классификация мешала recovery orphaned handle.
2. Устаревший operation-lock snapshot закрывающейся вкладки давал ложный RECONCILED.
3. Settled admission rejection оставлял running на Node22/native-подобном runtime.
4. Сбой получения context мог потерять связность never-sent draft при повторе.
5. chooseMine использовал старые conflict operation IDs после v3 rebase.
6. Свежий template review обращался к закрытым raw tables вместо существующих RPC.
7. Legacy resolver нуждался в той же current-ACL redaction, что и replay.
8. При расширении scheduled lifecycle admission closure выявлен опасный порядок
   shared→exclusive для двух cleaners; exclusive теперь берётся сразу, добавлен
   настоящий concurrent SQL test.
9. Неизвестный запрос в replay_only epoch мог оставлять пустой per-user budget.
   Отказ теперь предшествует allocation; при crossing deadline пустая запись
   удаляется. Добавлен HTTP test нового аккаунта без единого receipt.
10. При PWA gateway fallback WebKit иногда открывал первый auth route
    forgot-password. В существующем auth Stack явно задан начальный login;
    отдельная проверка сохраняет прямой переход на forgot-password.
11. После acknowledgement в другой вкладке собственный tab binding мог удерживать
    review без видимого shared envelope. Он восстанавливается под account fence
    для явного согласования; более новый envelope не перезаписывается и POST
    не выполняется. Отдельный unit case проверяет обе ветки.

Дополнительно исправлены fixture/barrier ошибки из части 5. B01–B07/P02–P05
проверены повторно: HTTP denials, notification bulk retry, snapshot completeness,
independent revisions, PWA shell, profile CAS draft, bounded refresh, receipt
isolation, реальные Auth/Data/Realtime проверки, ошибки модальных диалогов,
responsive progress. Прежние 37 dirty files не сброшены и не заменены baseline.

Риски и условия:

- Exactly-once ограничен retained namespace/H и сохранностью handle. Expired
  unknown не отправляется заново автоматически, но его история после GC не
  восстанавливается из текущего состояния.
- Default intent inference сохраняется для старых callers. Для неоднозначного
  случая требуется явный new/retry; review UI использует retry с прежним handle.
- Global budget row и lineage issuance fence — реальные точки сериализации.
  Их capacity/latency и GC throughput требуют production-измерений.
- Heap/index/WAL/backup headroom и autovacuum нельзя вычислять только по logical
  bytes; DELETE не равен уменьшению дискового файла.
- Нельзя безопасно открыть restored/PITR database до внешнего fence и rotation.
- Node-forge остаётся security risk tooling; gate не продлён и не обновлён
  автоматически. Braces withdrawn — изменение upstream, не наше security fix.
- Точный исторический R03 эпизод не доказан. 100-серии не доказывают отсутствия
  всех будущих гонок. Unit bootstrap deadline чувствителен к одновременной
  тяжёлой нагрузке; физические устройства остаются отдельной приёмкой.

## 8. Репозиторий

<!-- REPOSITORY-SNAPSHOT:START -->
HEAD до и после: `810f1a367b7d350b5e3ce1bb0b62f22093ba9049`. Staged: **пусто**.
Baseline содержит 37 dirty files. В таблицах колонка B01 отмечает именно эти
исходные файлы, включая прежние untracked; колонка R01 отмечает текущую фазу.
28 прежних файлов не изменены текущим заданием, 9 аккуратно расширены.

### Modified (51)

| Файл | Был dirty в B01–B07/P02–P05 | Изменён R01–R03 |
| --- | --- | --- |
| `package-lock.json` | нет | да |
| `package.json` | нет | да |
| `scripts/connectivity-recovery-browser-smoke.mjs` | нет | да |
| `scripts/generate-service-worker.mjs` | да | нет |
| `scripts/pwa-mobile-browser-smoke.mjs` | да | да |
| `scripts/regression-mutation-browser.mjs` | да | да |
| `scripts/run-audit-sql-tests.mjs` | да | да |
| `scripts/security-receipt-races.mjs` | нет | да |
| `scripts/security-test-harness.mjs` | да | нет |
| `scripts/test-security-hardening.mjs` | да | нет |
| `src/app/(app)/notifications.tsx` | да | нет |
| `src/app/(app)/profile.tsx` | да | нет |
| `src/app/(app)/projects/[id].tsx` | да | нет |
| `src/app/(app)/projects/[id]/progress.tsx` | да | нет |
| `src/app/(app)/projects/[id]/tasks/[taskId].tsx` | да | нет |
| `src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx` | да | нет |
| `src/app/(app)/templates.tsx` | да | нет |
| `src/app/(auth)/_layout.tsx` | нет | да |
| `src/components/ui/realtime-indicator.tsx` | нет | да |
| `src/features/auth/AuthProvider.tsx` | да | нет |
| `src/features/notifications/notifications.ts` | да | нет |
| `src/features/projects/projects.ts` | да | нет |
| `src/lib/errors/user-message.ts` | да | да |
| `src/lib/local-cache/driver.native.ts` | нет | да |
| `src/lib/local-cache/driver.ts` | нет | да |
| `src/lib/local-cache/driver.web.ts` | нет | да |
| `src/lib/local-cache/failed-chain.ts` | нет | да |
| `src/lib/local-cache/outbox.ts` | нет | да |
| `src/lib/local-cache/refresh-scheduler.ts` | да | нет |
| `src/lib/local-cache/repository.ts` | да | нет |
| `src/lib/local-cache/runtime-config.ts` | нет | да |
| `src/lib/local-cache/runtime-state.ts` | нет | да |
| `src/lib/local-cache/status.ts` | нет | да |
| `src/lib/local-cache/sync.ts` | нет | да |
| `src/lib/local-cache/types.ts` | нет | да |
| `src/lib/local-cache/use-sync-indicator.ts` | нет | да |
| `src/lib/supabase/mutation.ts` | да | да |
| `src/types/database.types.ts` | нет | да |
| `tests/mutation-contexts.test.ts` | нет | да |
| `tests/notification-count-cache.test.ts` | нет | да |
| `tests/offline-auth-profile.test.tsx` | да | нет |
| `tests/offline-native-storage.test.ts` | нет | да |
| `tests/offline-phase6-runtime.test.ts` | нет | да |
| `tests/offline-repository-races.test.ts` | да | нет |
| `tests/offline-sync.test.ts` | да | да |
| `tests/offline-web-storage.test.ts` | нет | да |
| `tests/online-mutation.test.ts` | да | да |
| `tests/read-refresh-scheduler.test.ts` | да | нет |
| `tests/security-policy-gate.test.mjs` | нет | да |
| `tests/sync-ux.test.tsx` | нет | да |
| `tests/tasktrace-regressions.test.ts` | да | нет |

### Untracked (23)

| Файл | Был dirty в B01–B07/P02–P05 | Изменён R01–R03 |
| --- | --- | --- |
| `docs/audit-fixes-2026-10-22.md` | да | нет |
| `docs/client-operation-protocol-v3.md` | нет | да |
| `docs/operation-window-implementation-2026-10-23.md` | нет | да |
| `scripts/audit-fixes-browser.mjs` | да | да |
| `scripts/audit-fixes-integration.mjs` | да | нет |
| `scripts/operation-window-crash.mjs` | нет | да |
| `scripts/operation-window-integration.mjs` | нет | да |
| `scripts/operation-window-load.mjs` | нет | да |
| `scripts/operation-window-ui-browser.mjs` | нет | да |
| `scripts/receipt-test-policy.mjs` | да | да |
| `src/features/projects/daily-progress-row.tsx` | да | нет |
| `src/lib/local-cache/operation-attempt.ts` | нет | да |
| `src/lib/supabase/operation-handle.ts` | нет | да |
| `supabase/migrations/20261022201114_audit_task_snapshot_revision.sql` | да | нет |
| `supabase/migrations/20261022201149_audit_rpc_outcomes.sql` | да | нет |
| `supabase/migrations/20261022202128_audit_receipt_budgets.sql` | да | нет |
| `supabase/migrations/20261023115036_operation_window_protocol.sql` | нет | да |
| `supabase/migrations/20261023115657_operation_window_lifecycle.sql` | нет | да |
| `supabase/tests/audit_fixes_test.sql` | да | нет |
| `supabase/tests/operation_window_test.sql` | нет | да |
| `tests/checklist-snapshot-reader.test.ts` | да | нет |
| `tests/notification-bulk-retry.test.tsx` | да | нет |
| `tests/operation-window-storage-contract.ts` | нет | да |

Новые файлы текущей фазы: `docs/client-operation-protocol-v3.md`, `docs/operation-window-implementation-2026-10-23.md`, `scripts/operation-window-crash.mjs`, `scripts/operation-window-integration.mjs`, `scripts/operation-window-load.mjs`, `scripts/operation-window-ui-browser.mjs`, `src/lib/local-cache/operation-attempt.ts`, `src/lib/supabase/operation-handle.ts`, `supabase/migrations/20261023115036_operation_window_protocol.sql`, `supabase/migrations/20261023115657_operation_window_lifecycle.sql`, `supabase/tests/operation_window_test.sql`, `tests/operation-window-storage-contract.ts`.
Новых migrations 2; прежние migration files не изменены.
Прежние untracked migrations B01 сохраняются в отдельной исходной категории.
Новые тестовые entry points: четыре operation-window scripts, operation_window_test.sql
и shared operation-window-storage-contract.ts; unit cases зарегистрированы существующими suites.
<!-- REPOSITORY-SNAPSHOT:END -->

Baseline/final hashes и пофайловое сравнение сохранены вне проекта. Все исторические
миграции побайтово совпадают с исходным baseline. Новые migration files не применялись
к production. Stage пуст; reset/stash/checkout/commit/push/deploy не выполнялись.
Зависимости изменены только в области R02, фактические пять version changes
перечислены выше. Сгенерированные exports, DB/browser evidence и приватные
окружения не добавлялись в tracked файлы.

## 9. Финальный вердикт

**COMPLETE WITH CONDITIONS.** Реализован локальный R01–R03 контур, подготовлены
миграции, durable storage/client/UI, dependency update и проверки настоящих
PostgreSQL/PostgREST/браузеров/крахов. Для эксплуатационной приёмки остаются
production sizing/configuration/cutover/restore fence, отдельный security review
node-forge и policy, physical Android/iOS acceptance и неподтверждённая историческая
причина R03. Внешнюю metadata-проверку React Native Directory также нужно
повторить: Expo Doctor дал 20/21. COMPLETE без этих оговорок не заявляется.
