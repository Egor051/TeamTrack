# TaskTrace: мобильное восстановление и активность Supabase — 17.10.2026

## Вердикт

**PARTIALLY FIXED.** Локально исправлены два воспроизводимых дефекта, оставлявших
приложение в ожидании при зависшем соединении: начальный refresh сессии и загрузка
HTML через Service Worker. Исправлена также потеря пометки офлайн-результата у
объединённых чтений кеша. Production не изменён. Какой именно запрос и сетевой
сбой произошли на телефоне пользователя, установить задним числом нельзя:
клиентская трасса этого эпизода отсутствует. Проверка на физических Android/iOS
после развёртывания остаётся необходимой.

Рабочая база: `9895796`. Исходное рабочее дерево было чистым. На этапе диагностики
изменения выполнены локально, без staging, commit и push. Последующая публикация
в Git разрешена пользователем отдельно. Hosted-миграции и инфраструктура не менялись.

## А. Supabase

### Границы измерений

Основное окно журналов зафиксировано **16.10.2026 10:10 — 17.10.2026 10:10 UTC**,
до диагностических действий этой сессии. Отдельно исследовано окно мобильного
подключения 17.10, 10:00–10:20 UTC. SQL-статистика и планы — текущие снимки;
накопительные счётчики не выдаются за нагрузку ровно за сутки.

Предоставленные 5 949 совпадают с суммой пяти категорий событий. Их нельзя
интерпретировать как 5 949 HTTP-запросов приложения к базе. PostgreSQL, Gateway,
Auth и Realtime описывают разные уровни, и одно действие может оставить несколько
записей.

В зафиксированном окне получены следующие значения:

| Источник | События | Объяснение |
| --- | ---: | --- |
| PostgreSQL | 3 503 | 2 880 start/completed дедлайнов, 576 checkpoint start/complete, административные операции и небольшое число служебных событий |
| API Gateway | 2 434 | Завершённые HTTP-запросы, включая OPTIONS, HEAD и WebSocket handshake |
| Realtime | 44 | INFO: обслуживание partitions, janitor, запуск/перезапуск tenant/репликации |
| Auth | 16 | 8 INFO Login и 8 request completed с token_revoked на POST /token; это не 16 отдельных входов |
| Storage | 11 | 5 tenant health checks, 4 GET tenant metadata, начало и завершение служебных migrations; загрузок objects здесь нет |
| PostgREST | 205 | Подключение, настройка пула и schema-cache reload, в том числе во время административных изменений |
| PgBouncer | 11 609 | В основном локальные подключения пользователя pgbouncer и закрытия: 5 765 / 5 764; также периодическое обновление серверных соединений |

Счётчики немного отличаются от исходного скриншота из-за другого конца окна.
Между первыми выборками пришла ещё одна запись Gateway; итоговый зафиксированный
результат — 2 434. Запросы текущей диагностики находятся за пределами окна.

### pg_cron и дедлайны

В production зарегистрированы ровно два активных задания:

| Задание | Расписание UTC | Запуски за последние 24 ч при SQL-снимке 10:16 UTC | Среднее / p95 / максимум |
| --- | --- | ---: | --- |
| `tasktrace-checklist-deadlines` | `* * * * *` | 1 440, ошибок 0 | 8,55 / 18,16 / 305,70 мс |
| `tasktrace_cleanup_task_item_sync_changes_daily` | `17 3 * * *` | 1, ошибок 0 | 57,86 мс |

Пересечений исполнений одного задания за сутки не найдено. На момент проверки
нет незавершённых запусков. 1 440 × 8,55 мс — около **12,3 секунды времени
исполнения за сутки**, а не измерение CPU utilization.

`completed: 1 row` означает одну строку результата SQL `SELECT`, возвращающего
число обработанных элементов. Это сообщение появляется и при результате `0`.
Оно не означает одно уведомление каждую минуту. Запуски и результаты хранятся
в `cron.job_run_details` — штатный механизм [Supabase Cron](https://supabase.com/docs/guides/cron).

Функция `private.process_checklist_deadlines(integer)`:

1. Выбирает только `next_transition_at <= now()`, ограничивая порцию по умолчанию
   1 000 строками, максимумом 10 000.
2. Блокирует project → task → deadline state через `FOR UPDATE SKIP LOCKED`.
3. После блокировки повторно проверяет наступление перехода.
4. Перечитывает актуальные срок, прогресс и архивный статус, вычисляет следующий
   переход. Уведомление и audit event создаются при фактической смене состояния.
5. Использует существующую дедупликацию уведомлений и сериализацию состояния.

Пустая очередь делает SELECT, но не входит в цикл, не вызывает refresh для
каждого элемента и не переписывает task items/notifications. Состояний сейчас 2,
запланированных и наступивших переходов 0. За основное окно в deadline audit
найдено одно событие `set`, повторяющихся urgent/overdue событий нет.

Частичный индекс `checklist_deadline_next_transition(next_transition_at,item_id)
WHERE next_transition_at IS NOT NULL` существует и используется. Production
`EXPLAIN (ANALYZE, BUFFERS)` **только SELECT-кандидатов**, без запуска worker,
показал 0 строк, Index Only Scan, 8 buffer hits, 0 reads, 0 dirtied/written blocks,
0 temporary blocks; execution 0,202 мс. Небольшой hash join читает таблицу из
33 stages. Дополнительный индекс и изменение частоты не обоснованы.

Накопительная статистика worker при первом снимке: 2 244 вызова, 16,89 с execution,
0 shared reads, 0 temporary writes, 45 777 WAL bytes. Последующий снимок:
2 257 вызовов, 16,997 с, те же 45 777 WAL bytes. Счётчики не сбрасывались.
История cron занимает 456 KiB, 2 266 записей; проблемы разрастания сейчас нет.

### Предупреждения: конкретные причины

**Все 16 PostgreSQL WARNING** относятся к `application_name=mgmt-api`, роли
`postgres`, времени 00:04:43–02:12:29 UTC:

| Сообщение | SQLSTATE | Количество | Причина |
| --- | --- | ---: | --- |
| `there is already a transaction in progress` | `25001` | 8 | Вложенный BEGIN внутри транзакционной оболочки Management API |
| `there is no transaction in progress` | `25P01` | 8 | Внешний COMMIT после завершения внутренней транзакции |

Связанные административные statements содержат транзакционные BEGIN/COMMIT.
Это не дедлайн-worker и не запросы мобильного клиента. Не следует менять ранее
применённые миграции для очистки истории предупреждений. При дальнейших
административных вызовах нужно учитывать транзакционную оболочку инструмента.
Такие же предупреждения могут создавать диагностические SQL с явными BEGIN/
ROLLBACK; исходные 16 отделены фиксированным окном до этой сессии.

Во время текущего аудита один read-only SELECT получил 42703: protocol_version
был ошибочно запрошен как колонка конфигурационной таблицы. В этой архитектуре
версию добавляет RPC; выборка исправлена на реальные поля. Этот диагностический
отказ не менял данные и находится вне исходного окна журналов.

**Два Gateway 4xx** пришли из PowerShell 7.6.7 на Windows:

| Время UTC 16.10 | Запрос | Результат и установленная причина |
| --- | --- | --- |
| 18:31:49 | GET `/rest/v1/` | 401, `sb_error_code=UNAUTHORIZED_INVALID_API_KEY_TYPE`: introspection требует secret API key. Повторный безопасный GET с publishable key вернул `Secret API key required` |
| 18:32:45 | GET `/rest/v1/projects?select=id&limit=0` | 406, `Proxy-Status: PostgREST; error=PGRST106`: выбрана схема, не разрешённая конфигурацией Data API |

Код `PGRST106` подтверждён заголовком ответа. Имя запрошенной схемы и тело старого
ответа в доступном логе отсутствуют; они не восстановлены по предположению.
Значение кода описано в [документации Supabase](https://supabase.com/docs/guides/troubleshooting/pgrst106-the-schema-must-be-one-of-the-following-error-when-querying-an-exposed-schema).
Расширять exposed schemas или grants ради этих диагностических запросов не нужно.
Текущий клиент использует Auth health и Data API probe с пользовательским JWT.

### Реальная нагрузка и запросы приложения

Gateway: 1 631 GET, 546 POST, 231 OPTIONS, 26 HEAD. Из них 10 ответов 101 —
WebSocket handshake, 2 ответа 204 и 2 ответа 4xx. Ошибок HTTP 5xx в этом окне нет.
Максимальный час — 878 запросов, около 0,244 запроса/с в среднем за этот час.
Журналы завершённых запросов не показывают запрос, который завис до Gateway
или ещё не завершился.

Основные успешные запросы: tasks 401, project_members 260, task_items 249,
task_assignees 248, projects 242, checklist_overview 144,
list_task_item_last_editors 131, get_my_task_role 110. Это списки, права,
назначения, прогресс и информация последнего редактора. Account manifest —
81 успешный POST, page — 30, pull changes — 55, runtime config — 36. HEAD
notifications использует count без загрузки списка; OPTIONS — CORS preflight.

Read-only проверка production runtime config подтвердила write_enabled=true и
sync_enabled=true. В опубликованном JS обе build-функции offline WRITE/SYNC
также возвращают true. Эти значения не менялись; при подготовке окончательной
локальной web-сборки сохраняются существующие build flags.

Средний origin time GET 99,8 мс, POST 182,44 мс; p95 352,5 и 542,75 мс.
Максимум завершённых запросов в основном окне — 984 мс. Это время Gateway/origin,
оно не равно чистому CPU-времени SQL и не включает весь клиентский путь.

База занимает 17 MB. На снимке 10:31:51 UTC: 0 ожидающих locks, 0 активных
посторонних client queries, 0 deadlocks; shared buffers 224 MiB, observed client
buffer evictions 0. С момента первого снимка PostgreSQL database reads остались
3 045. Накопительные temporary bytes выросли; top retained statements со spill
относятся к административной интроспекции/catalog/statistics запросам роли
postgres, включая текущую диагностику, а не worker дедлайнов. История статистики
с 30.09 не позволяет приписать все исторические temporary bytes одному источнику.

Checkpoints: 288 пар за сутки, то есть обычный интервал 5 минут при текущем
`checkpoint_timeout=300`, `max_wal_size=1024 MB`. Это механизм долговечности;
сам факт checkpoint не означает перегрузку. См. [PostgreSQL WAL configuration](https://www.postgresql.org/docs/17/wal-configuration.html).

Прямые временные ряды host CPU, RSS/RAM и дисковой latency через доступные MCP
не получены; `track_io_timing=off`, поэтому нулевые timing counters не доказывают
нулевое время I/O. Денежная стоимость запросов не вычисляется из количества
логов. По измеренным длительностям, планам, locks и запросам **проблема
производительности deadline cron не подтверждена**. SQL, частота заданий и
логирование не изменены; сравнение production «после оптимизации БД» неприменимо.

## Б. Мобильная версия

### Наблюдение пользователя и границы атрибуции

Телефон Android показывал загруженный сайт с ошибкой сети через Wi-Fi, как с
зарубежным VPN, так и без него. После перехода на мобильную сеть и обратно сайт
заработал. Компьютер в том же Wi-Fi продолжал работать. Эти факты не позволяют
назначить причиной провайдера, DNS, VPN или региональную блокировку.

В отдельном окне журнала Android-запросы появляются после 10:15 UTC: 51 успешный
ответ 200, 3 handshake 101 и один 204 за эту минуту; максимум origin time 511 мс.
Есть ещё 12 успешных запросов и handshake в 10:19. В основном окне до 10:10
Android-запросов нет. Отсутствие завершённых ответов не показывает, где завис
неуспешный клиентский запрос. Полная идентичность контролируемых воспроизведений
эпизоду на физическом телефоне не доказана.

### Подтверждённый дефект 1: начальное восстановление Auth

При сохранённой истёкшей сессии GoTrue начинает POST token refresh.
`connectivityFetch` ограничивал Auth transport только когда уже шёл recovery.
Первый refresh не имел собственного deadline. Если соединение не возвращало
ни ответа, ни ошибки, SDK/getReadSession оставались pending, connectivity
оставалась optimistic-online, а существующий переход на локальную сессию и
кеш не запускался. Смена сети вызывала offline event и освобождала UI.

Воспроизведение выполнено **на скачиваемой production-сборке** в чистом Chromium
с Android browser descriptor. Синтетическая истёкшая сессия оставалась только
в изолированном браузере; все запросы Supabase перехвачены и не отправлены в
production. Один token request удержан без ответа: через 12,211 с всё ещё
«Загрузка…», JavaScript exceptions нет. После offline event появляется основной
экран с корректной сетевой ошибкой при отсутствии кеша.

Исправление: тот же существующий пятисекундный бюджет применяется к начальному
token refresh и Auth GET; `boundedOperation` одновременно ограничивает Promise
и отменяет fetch, объединяя deadline с caller/Request signal. Signup, email
resend и обычные mutation RPC не получают этот новый короткий timeout.
Авторитетные 401/403 не превращаются в offline fallback.

После исправления на локальном production export основной экран появился за
**5,544 с без переключения сети**. Отсутствующий кеш отображается как недоступные
данные. Регрессия с настоящим GoTrue SDK проверяет
сохранённую identity, чтение IndexedDB, единственный зависший HTTP request,
последующее автоматическое восстановление и ротацию refresh token без network
toggle. Дополнительные тесты проверяют caller signal, транспорт, игнорирующий
abort, cleanup timers и сохранение 401/403.

### Подтверждённый дефект 2: PWA navigation без deadline

У установленного Service Worker `NetworkOnly` ждал ошибку соединения, чтобы
обратиться к уже существующему `/offline-shell.html`. При соединении, которое
сохраняло navigator.onLine=true и удерживало HTML без ответа, холодное открытие
вкладки/PWA оставалось пустым, хотя все ресурсы были подготовлены.

На отдельном loopback HTTP-сервере с настоящим generated Workbox это
воспроизведено и в Chromium, и в WebKit: navigation не завершился за 8 секунд,
JS exceptions нет. Исправление ограничивает fetch навигации пятью секундами и
передаёт отказ существующему PrecacheFallbackPlugin. Новый кеш или отдельный
offline engine не создаётся. Scope fallback по-прежнему исключает API, ресурсы
и внешние hosts. Для текущего generateSW использован штатный fetch plugin:
генератор Workbox 7 отклоняет shortcut networkTimeoutSeconds у NetworkOnly,
хотя runtime поддерживает его. Общий подход описан в [Workbox network timeout](https://developer.chrome.com/docs/workbox/forcing-a-network-timeout).

| Сопоставимый сценарий | До | После |
| --- | --- | --- |
| Истёкшая сессия, первый refresh не отвечает | 12,211 с: всё ещё loading; без deadline | 5,544 с: UI освобождён без смены сети |
| Холодная PWA navigation, HTML не отвечает, Chromium | timeout теста 8 с, пусто | 5,093 с, кешированная оболочка |
| То же, WebKit | timeout теста 8 с, пусто | 5,387 с, кешированная оболочка |
| Ожидающее обновление Service Worker | Автоматическая перезагрузка не требуется | Ожидает кнопки; после нажатия ровно один document reload в обоих движках |

### Подтверждённый дефект 3: пометка офлайн-результата при объединении чтений

Когда два читателя ожидали один HTTP-запрос, transport failure корректно
переводил первое чтение на кеш. Но filterCached у второго создавал новый массив
и терял пометку isCachedResult. Данные были сохранёнными, а UI мог не показать
соответствующее сообщение. Это отдельный дефект отображения происхождения
данных; связь с исходным отказом телефона не доказана.

Регрессионный тест до исправления получил [true,false] для двух результатов
одного запроса. В существующем cache single-flight применён inheritCachedResult
к результату фильтра; после — [true,true], HTTP-запрос по-прежнему один. RLS,
ACL, account fences, состав данных и алгоритм синхронизации не изменены.

### Production, ресурсы и платформы

Сессия, SW и IndexedDB принадлежат конкретному браузеру/устройству. Оба дефекта
зависят от состояния соединения и локальных данных, воспроизводятся на desktop
движках и не связаны с шириной экрана. Это допускает разное поведение телефона
и ПК в одном Wi-Fi. Фактический возраст сессии и состояние кеша телефона в момент
сбоя не измерены.

- DNS сайта: A `178.209.127.53`; AAAA не опубликован. У Supabase получены A
  `8.47.69.0`, `8.6.112.0`; AAAA в проверенном ответе отсутствует. Это снимок
  DNS используемого окружения, а не телефона или всех операторов.
- HTTP → HTTPS: 308. HTTPS root, основной JS и SW: 200. TLS 1.2 отдельно
  проверен. Сертификат tasktrace.ru, Let's Encrypt YE1, действует
  30.09.2026–29.12.2026; проверка цепочки не отключалась.
- Production HTML указывает на entry `3219819520154f1c76deebab67dcff7f`,
  JavaScript доступен с корректным MIME, gzip поддерживается. В нём нет
  loopback URL тестового backend. На чистом запуске Chromium и WebKit экран
  входа загрузился без JS/console errors; повторный визит и protected deep
  link корректно приводят к входу без сессии.
- CORS preflight к Supabase от origin tasktrace.ru: 200 с разрешёнными
  authorization/apikey/content-type/x-client-info. Общая ошибка CORS/CSP не
  воспроизведена; это не исключает локальные privacy/DNS/network условия телефона.
- Production Chromium с установленным SW успешно открыл кешированный login
  offline. WebKit Windows при context.setOffline дал внутреннюю ошибку движка;
  она **не объявлена дефектом iOS**. Вместо этого новый тест проверяет WebKit
  при реальном обрыве TCP сервером и при зависшем HTTP — оба сценария проходят.
- Ограничение WebKit воспроизведено на отдельном минимальном Service Worker без
  TaskTrace, Workbox, Auth и IndexedDB: direct Response, fetch→Response fallback
  и fetch→Cache Storage fallback. Chromium прошёл все три контроля, WebKit дал
  тот же internal error во всех трёх. Это отделяет ограничение настольного
  инструмента от исследуемого приложения; физический iOS этим не проверен.
- Browser descriptors включают mobile UA/touch, используется отдельный WebKit,
  а не только изменение размера окна. Однако это Windows browser automation,
  **не физические Android/iOS и не реально установленная на телефоне PWA**.
- Физические Wi-Fi/mobile/VPN сценарии после исправления не проверены. Приватный
  DNS телефона, carrier routing, фактическая сессия и storage на нём не прочитаны.
- Кеш приложения не удалялся в качестве «исправления». Offline outbox, ACL,
  пользовательские namespaces и протокол синхронизации не изменены.

### Отдельная подтверждённая проблема production-конфигурации

Caddy возвращает **200 text/html** и index.html для отсутствующего
`/_expo/static/js/web/entry-missing-diagnostic.js`. Это неправильный ответ для
ресурса: при ссылке на удалённый bundle браузер получит HTML вместо JavaScript.
Связь этого дефекта с сообщением пользователя не установлена.

Также у проверенного sw.js не было явного Cache-Control. Клиент уже использует
updateViaCache=none; отсутствие заголовка само по себе не доказало причину сбоя.

Подготовленное решение для администратора Caddy: объединить с текущим host block
следующее, подставив фактический root. **Не применялось.** Сохранить действующие
TLS и остальные настройки; прошлые hashed assets желательно сохранять на период
обновления ранее открытых клиентов.

```caddyfile
tasktrace.ru {
    root * /srv/tasktrace/current/dist
    encode zstd gzip

    @worker path /sw.js /workbox-*.js
    header @worker Cache-Control "no-cache, no-store, must-revalidate"
    @bundles path /_expo/static/*
    header @bundles Cache-Control "public, max-age=31536000, immutable"

    @assets path /_expo/* /icons/* /sw.js /workbox-*.js /manifest.webmanifest /favicon.ico
    handle @assets {
        file_server
    }
    handle {
        header Cache-Control "no-cache"
        try_files {path} /index.html
        file_server
    }
}
```

После отдельного разрешения/применения проверить caddy validate, существующий
bundle=200 с JavaScript MIME, отсутствующий bundle=404, sw.js=no-cache, app deep
links и предыдущую версию PWA. Текущий production обслуживает Caddy; изменение
только vercel.json не исправит его поведение.

## В. Общие результаты

### Дефекты и статус

| Приоритет | Дефект | Статус |
| --- | --- | --- |
| P1 | Начальный Auth refresh зависает без deadline и блокирует переход к локальной сессии | Исправлен и воспроизведение проверено локально |
| P1 | Холодная PWA navigation зависает при onLine=true, не используя готовую оболочку | Исправлен; Chromium/WebKit regression PASS |
| P2 | Объединённое чтение с фильтрацией теряет пометку transport fallback на кеш | Исправлен; отдельная регрессия PASS |
| P2 | Production Caddy возвращает HTML/200 для отсутствующих JS assets | Решение подготовлено; инфраструктура не изменена |
| P3 | Browser smoke требовал persisted offline_waiting, хотя ожидание может вычисляться из runtime | Проверка приведена к контракту: нет ложной готовности/сохранённого running; reconnect проверяется отдельно |

P0 не обнаружен. Большое количество штатных cron/checkpoint logs не объявлено
дефектом. Бесконечный цикл запросов/подписок в исходном production-окне не
обнаружен. Нет доказательств, что мобильный сбой создавал эту активность:
cron работает независимо от клиента; основные PostgreSQL logs — его расписание.

### Проверки

- Исходный npm test: 59 файлов / 664 теста PASS.
- После исправлений npm test: 60 файлов / 673 теста PASS; typecheck/lint PASS.
- Окончательная локальная web-сборка с production URL и существующими WRITE/SYNC
  build flags=true: PASS; повторный PWA-прогон обоих движков на ней PASS.
- Expo export Android и iOS: PASS; это проверка сборки, не физических устройств.
- Девять дополнительных unit/regression cases: зависший первый Auth request,
  caller signal, Request.signal, игнорирование abort, Auth recovery, 401/403,
  реальный SDK + IndexedDB + автоматическая ротация token, сохранение пометки
  кеша у всех объединённых отфильтрованных результатов.
- Новый scripts/pwa-mobile-browser-smoke.mjs: отдельные Chromium и WebKit,
  первый/повторный визит, deep link без сессии, TCP failure, cold navigation
  при onLine=true, waiting SW update и ровно один reload — PASS.
- Изолированная SQL база: 16 suites PASS, upgrade/concurrency/Data API checks
  PASS, настоящий pg_cron в отдельном disposable PostgreSQL создаёт ровно одно
  overdue notification без клиента. Hosted worker не запускался вручную.
- Официальный Supabase security advisor SQL локально: 0 ERROR. 61 WARN об
  execute security-definer RPC и 8 INFO об RLS без policy — существующие
  архитектурные сообщения; это не те 16 PostgreSQL WARNING.
- Изолированные настоящие Auth/PostgREST/Realtime/Mailpit: backend Data API/Auth/
  Realtime PASS, web/native PKCE PASS, Realtime lifecycle с reconnect,
  revoke/re-auth denial, восстановлением membership и downgrade PASS.
- Отдельный чистый аккаунт, Extended, Chromium с mobile descriptor: холодное
  открытие истории при navigator.onLine=false и повторное локальное чтение
  показывают сохранённые события с сообщением об offline history; JS errors 0.
- Legacy account-offline-browser-smoke: **полный PASS не засчитывается**.
  Выполнены Basic, навигация, reconnect, outbox/receipts, coalescing, 94% recovery
  и scheduler measurements; итоговый запуск остановился на offline history.
  Минимальный контроль agent-browser 0.38.2 показал navigator.onLine=false до
  open и true после навигации в сценарии с двумя вкладками. Добавлена явная
  проверка сохранения offline emulation; ожидание persisted offline_waiting
  заменено проверкой реального runtime-контракта. Этот сбой инструмента не
  объявляется ошибкой загрузки истории приложения.
- Новый mobile-offline-browser-smoke: отдельный Playwright context без legacy
  CLI проверяет настоящие локальные Auth/API, Extended после reload, историю,
  220 уведомлений с offline pagination, Extended→Basic offline, cold reload и
  mounted reconnect. Chromium: PASS, 0 API requests в offline, JS errors 0.
  Отдельный запуск только Chromium завершён с exit code 0; результат сохранён
  в integration-results-6472.json и mobile-offline-results.json.
  WebKit: запуск остановлен внутренней ошибкой инструмента при setOffline;
  общий прогон двух engines **не объявлен PASS**.
- Текущий scheduler-browser.json записан 17.10, в ходе этой проверки: 45 секунд,
  0 HTTP; удалённая items page восстановлена единственным page RPC. Старый
  файл от 16.10 не использован как свидетельство текущего замера.

Повторение браузерного PWA-теста с предоставленным окружением:

```powershell
$env:EXPO_PUBLIC_OFFLINE_WRITE_ENABLED = 'true'
$env:EXPO_PUBLIC_OFFLINE_SYNC_ENABLED = 'true'
npm run build:web
$env:TASKTRACE_PLAYWRIGHT_MODULE = 'C:/Users/chupa/AppData/Local/Programs/Python/Python310/lib/site-packages/playwright/driver/package'
node scripts/pwa-mobile-browser-smoke.mjs

# Полный authenticated offline-набор в поддержанном здесь Chromium:
$env:TASKTRACE_MOBILE_BROWSER_ENGINES = 'chromium'
$env:NODE_USE_ENV_PROXY = '1'
node scripts/run-security-integrations.mjs scripts/mobile-offline-browser-smoke.mjs
```

Для другого окружения установить/предоставить Playwright и соответствующие
Chromium/WebKit; script по умолчанию загружает пакет playwright. Он блокирует
HTTP вне своего временного loopback server. Изолированные backend tests
используют scripts/run-security-integrations.mjs; нельзя направлять тестовые
сценарии в hosted.

### Повторная проверка перед публикацией в Git

17.10.2026 повторно выполнены и прошли:

- npm test: 60 файлов / 673 теста; отдельно npm run typecheck и npm run lint.
- node scripts/run-audit-sql-tests.mjs --cron --advisors: 16 SQL suites,
  upgrade, concurrency, Data API, настоящий pg_cron и 0 advisor ERROR.
- scripts/run-security-integrations.mjs: все 7 выбранных сценариев завершились
  с exit code 0 — backend, PKCE, concurrency, bootstrap HTTP, password Auth,
  Realtime lifecycle и mobile-offline-browser-smoke в Chromium. Артефакт:
  .expo/security-evidence/integration-results-21392.json.
- npx expo export --platform all --output-dir .expo/mobile-delivery-export:
  Web, Android и iOS PASS.
- npm run build:web с действующей production-конфигурацией и обоими build flags
  true; затем scripts/pwa-mobile-browser-smoke.mjs: Chromium 5,105 с,
  WebKit 5,382 с, по одному reload после кнопки, JS errors 0.
- Состав рабочей фазы: ровно 10 файлов, посторонних путей нет. Проверка пробелов,
  credential patterns и совпадений со значениями секретов из .env — PASS.

Новых функциональных изменений при этой проверке не потребовалось. Ограничения
физических устройств, WebKit offline emulation и legacy CLI остаются описанными
выше; эти неполные сценарии не объявляются прошедшими.

### Файлы

- src/lib/connectivity/fetch.ts — deadline начального Auth и композиция сигналов.
- src/lib/local-cache/cache.ts — сохранение происхождения отфильтрованного
  результата у читателя общего запроса.
- scripts/generate-service-worker.mjs — deadline navigation через Workbox plugin.
- tests/mobile-transport-recovery.test.ts — transport regression.
- tests/offline-connectivity.test.ts — real SDK/cache/recovery regression.
- tests/local-cache.test.ts — coalesced filtered fallback regression.
- scripts/pwa-mobile-browser-smoke.mjs — проверка двух browser engines и SW update.
- scripts/mobile-offline-browser-smoke.mjs — реальные изолированные Auth/API,
  offline history/notifications, сохранение выбранной схемы и reconnect.
- scripts/account-offline-browser-smoke.mjs — проверка runtime waiting и
  отсутствия ложного persisted running/ready.
- docs/mobile-supabase-diagnostics-2026-10-17.md — этот отчёт.

Сырые обезличенные агрегаты, browser JSON и screenshots доступны локально в
.expo/mobile-diagnostics; integration logs — .expo/security-evidence. Это
игнорируемые результаты проверок. В отчёт не включены токены и пользовательские
данные.

### Что требуется в production

Миграций БД для этих исправлений **нет**. Нужна отдельная доставка новой
production web-сборки с действующей production-конфигурацией и проверка обновления
SW. После изолированных тестов dist пересобран штатным npm run build:web с
production URL и сохранением обоих действующих WRITE/SYNC build flags=true;
loopback backend в итоговом JS отсутствует. Сборка остаётся локальной. При
будущей доставке нужно снова использовать актуальное production environment.
Применение подготовленного изменения Caddy требует отдельного разрешения.

После доставки провести на физических Android и iOS: чистый браузер и повторный
визит, обычную вкладку и установленную PWA, актуальную и истёкшую сессию,
обновление версии, недоступность Supabase при доступном сайте, Wi-Fi/mobile и
возврат в приложение после background. До этого полный production FIXED
не подтверждён.
