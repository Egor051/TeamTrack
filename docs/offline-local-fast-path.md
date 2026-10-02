# Автоматический offline/local fast-path — проверка 02.10.2026

Этот отчёт фиксирует локальную реализацию и проверки до Git-публикации. На этапе реализации commit, push и deploy не выполнялись. Linked Supabase, hosted schema и production flags не изменялись; новые миграции не нужны. SQL/backend/browser проверки используют только локальный Supabase. `test:sql` штатно пересоздал локальную тестовую БД. Отдельно выполнены read-only HTTP проверки доступности probe endpoints в настроенном Supabase; изменений там не было.

## Причина задержки и измерение до исправления

Production static Expo Web/PWA, service worker, headless Chromium через agent-browser. Настоящий тестовый пользователь и настоящий Basic preload из локального Supabase; затем браузер переведён offline. Это измерение на данном Windows компьютере с небольшим набором тестовых проектов, а не замер на физическом телефоне или установленной standalone PWA.

`readThroughCache` всегда выполнял online callback, даже когда `navigator.onLine === false`. Сохранённые данные уже были доступны, но Supabase/PostgREST GET автоматически повторял упавшие запросы через 1, 2 и 4 секунды. На проекте цепочка `getProject → listTasksWithStats → listProjectTasks → task_items` последовательно проходила несколько таких ожиданий.

Реальная трасса `/projects` до исправления, относительно navigation start:

| Событие | Время, мс |
| --- | ---: |
| Чтение сохранённой session | 60 |
| Первое чтение локального списка завершено | 90 |
| `GET /rest/v1/projects` | 99 |
| Первый transport failure | 107 |
| Повторные GET | 1111 / 3113 / 7115 |
| Последний transport failure | 7117 |
| IndexedDB fallback | 7117 |
| Первый отображённый список | 7124 |

Для project route GET `projects` начинались на 120 / 1128 / 3130 / 7136 мс; GET `tasks` — на 7150 / 8155 / 10158 / 14162 мс; GET `task_items` — на 14167 / 15176 / 17178 / 21181 мс. Основной контент появился на 21195 мс.

Помимо основных reads, запускались `get_my_profile`, permission reads `project_members` / `task_assignees`, notifications count, `getMyTaskRole`, last editors и фоновый `ChecklistLocalRepository.refreshTaskItems`. Progress loaders также начинали с `getCurrentUser` (`/auth/v1/user`) и читали daily audit. Members/templates/profile имели готовые локальные read models; profile и templates обычно отображались быстро благодаря быстрому отказу POST/Auth и существующему fallback. Чек-лист уже имел отдельную локальную hydration и был виден быстро, хотя дополнительные запросы продолжали выполняться.

AuthProvider с непросроченной session не был источником 7–21-секундного ожидания: session storage читалась за 29–60 мс на большинстве маршрутов. Однако SDK `getSession()` может обновлять истекающий token: отдельно устранено ожидание SDK restoration/refresh для offline UI. Это соответствует поведению, описанному в [документации Supabase getSession](https://supabase.com/docs/reference/javascript/auth-getsession), и проверено по установленному исходному коду auth-js.

Полные before/after события сохранены в `.expo/offline-navigation-before.json` и `.expo/offline-navigation-after.json`. Test init script регистрирует navigation, session storage, IndexedDB reads, network start/failure/success и первый frame с ожидаемым содержимым. В production bundle эта instrumentation не включается.

## Connectivity и reads

Единое состояние находится в `src/lib/connectivity/state.ts`:

- `offline`: браузер сообщает `navigator.onLine === false`; также принимается отрицательное событие NetInfo. Cache-backed reads сразу идут в IndexedDB.
- `degraded`: подтверждён transport failure при формально доступной сети. Следующие cache-backed reads сразу идут в IndexedDB.
- `online`: успешный запрос Supabase или общий probe. При новом online startup до первого результата сохраняется прежний network-first путь; browser online сам по себе не подтверждает восстановление после offline/degraded.

Состояние живёт в JS runtime, не является пользовательской настройкой и не сохраняется как forced mode. Проверки navigator находятся в connectivity layer. Realtime, sync, runtime config и bootstrap используют этот слой и не блокируют открытие локального snapshot.

Recovery probe — одна общая single-flight последовательность: `GET /auth/v1/health` → SDK `getSession`/refresh → authenticated `GET /rest/v1/projects?select=id&limit=0`. Каждый transport этап ограничен 5 секундами; SDK recovery ожидание ограничено 35 секундами, чтобы дать закончиться уже начатому 30-секундному refresh retry lifecycle установленного SDK. Это фоновое ожидание не блокирует cached UI. На время SDK revalidation разрешается только Auth transport, UI reads остаются локальными до проверки Data API. При `navigator.onLine=false` исключение Auth transport не действует. Health alone не подтверждает доступность Data API. При отсутствии session доступный Auth позволяет вернуться к login; SDK сохраняет штатную обработку invalid session.

Проверка настроенного Supabase с publishable key показала, почему schema introspection не подходит для probe: HEAD/GET `/rest/v1/` вернули 401 «Secret API key required», тогда как Auth health вернул 200. В локальном окружении root endpoint возвращает 200, но anonymous query таблицы закрыта grants. Поэтому Data API probe использует восстановленный user JWT и нулевую выборку с RLS. Он не получает данные проектов и не меняет БД. Transport failure оставляет degraded. Доступный transport с 4xx/business response позволяет обычным loaders обработать authoritative denial; cache fallback на такую ошибку запрещён. Permission version принудительно обновляется при recovery, даже если отдельная permission query завершится denial.

Online event запускает revalidation; в degraded повторная проверка выполняется через 30 секунд. Reads не запускают probe. Неудачный probe оставляет degraded, успешный переводит online. Unit regression отдельно проверяет healthy Auth + dead Data API, single-flight, deadline и закрытие Auth exception после timeout. Ещё один regression использует реальный GoTrueClient: expired session, transport failure, SDK cooldown, локальное чтение во время cooldown, успешный refresh и новый токен после периодического recovery. Штатный 60-секундный SDK failure cooldown сохранён; при expired session он может отложить reconnect, но не initial offline render.

Переход online возобновляет session/profile revalidation, permission reads, Realtime subscriptions, account bootstrap и обычную sync/outbox логику. Permission version и Realtime invalidation обновляют экраны через существующие loaders.

`readThroughCache` сначала получает user-scoped session. В offline/degraded проверяет resource tombstones, читает snapshot, применяет существующий filter и повторно проверяет аккаунт перед возвратом. При отсутствии snapshot возвращается корректная transport/offline ошибка без network callback. Online callback остаётся главным источником данных; успешное значение сохраняется существующим compare-and-set способом. Первый transport failure устанавливает degraded и использует тот же локальный путь.

Глобальный `connectivityFetch` дополнительно предотвращает обращения вспомогательных queries/SDK retries в known offline/degraded. Transport error останавливает PostgREST retries через AbortError. HTTP/SQL/business errors сохраняют исходную семантику. `uiRead` ограничивает основные UI Data API queries 5 секундами и выключает их автоматические GET retries; bootstrap сохраняет свои 20 секунд, sync и SDK Auth refresh сохраняют собственную логику. Глобального уменьшения всех timeout нет. Deadlines используют AbortController, совместимый с native polyfill; отдельный regression с реальным PostgREST SDK и native AbortController проверяет timeout/fallback, отсутствие DOMException dependency и очистку таймера. Физический native device не проверялся.

Online network-first в shared cache не заменён глобальным stale-while-revalidate. Существующая локальная hydration чек-листа сохранена; её background refresh пропускается offline/degraded.

## Session, безопасность и локальные изменения

`src/lib/supabase/session.ts` восстанавливает offline identity через тот же storage adapter/key, который использует SDK. Наличие сохранённой session позволяет читать собственные локальные данные, включая expired token metadata, без ожидания `getUser` / refresh / SDK initialization. Если transport failure обнаружен уже во время SDK restoration, UI callers освобождаются через persisted session. Отсутствие session, logout и переключение аккаунта не обходятся.

Expired session допускает только локальное чтение: прежняя проверка срока session для offline mutations в runtime capabilities сохранена. После reconnect SDK выполняет обычное восстановление/refresh; invalid/expired server responses обрабатываются через существующие механизмы.

Offline logout сразу удаляет persisted session и очищает AuthProvider. SDK logout может завершиться позже, а его commit guard не может восстановить удалённую session. Storage events поддерживают смену offline session между вкладками.

401, 403, invalid JWT, ResourceAccessDeniedError и SQL/business errors не считаются transport failures. `uiRead` сохраняет HTTP status из PostgREST response в error, чтобы даже denial без привычного текста не терялся. Denied cache entry удаляется, resource tombstone сохраняется. Старые списки фильтруются по заблокированным проектам/этапам. Проверки account identity выполняются до и после локального чтения/filtering. Business RPC с HTTP 503 также не считается gateway failure; реальные 502/503/504 availability failures и DNS/reset/timeout codes распознаются отдельно.

Checkbox/state, percentage и comment продолжают использовать текущие overlay/outbox, UUID, sequence, conflict и receipt semantics. Runtime capabilities берутся из подтверждённого user-scoped snapshot offline/degraded; replay требует новой server confirmation после восстановления связи. Новых mutation types нет. Toggle, forced-offline, профильная настройка или новый UI indicator не добавлены.

## Измерения после исправления

Первое содержимое после hard reload, миллисекунды. В каждой строке после исправления зарегистрировано **0 Supabase HTTP requests и 0 probes** до и во время browser assertion.

| Маршрут | До | После |
| --- | ---: | ---: |
| `/projects` | 7124 | 190 |
| `/projects/:id` | 21195 | 142 |
| `/projects/:id/tasks/:taskId` | 76 | 75 |
| `/projects/:id/members` | 7088 | 71 |
| `/templates` | 80 | 72 |
| `/profile` | 66 | 68 |
| `/projects/:id/progress` | 21140 | 76 |
| `/projects/:id/tasks/:taskId/progress` | 7105 | 87 |

До исправления fetch instrumentation зарегистрировала соответственно 21 / 21 / 34 / 17 / 7 / 11 / 26 / 26 HTTP calls за browser assertion window. У task строка показывает уже существовавшую быструю hydration; исправление убирает ненужные запросы и ожидание дополнительных loaders. Profile/template разница в несколько миллисекунд не интерпретируется как значимое ускорение.

После исправления `/projects`: session read 148 мс, первое IndexedDB read 177 мс, последние локальные reads перед frame 187 мс, render 190 мс. Проект: session 31 мс, cache read start 120 мс, последний read перед frame 135 мс, render 142 мс. Task: session 31 мс, cache read start 58 мс, последний read перед frame 62 мс, render 75 мс. **Network wait before cache render = 0**.

Отдельный offline reload с expired persisted session metadata: `/projects` — 82 мс, project daily progress — 79 мс, 0 HTTP requests/probes. Derived daily progress теперь также выбирает сохранённые items до создания bulk SDK query. Unit/component regression дополнительно проверяет, что SDK getSession с никогда не завершающимся Promise не блокирует offline AuthProvider, cached profile и progress, а logout очищает session/UI сразу.

Fake-online/dead Supabase тест оставляет `navigator.onLine=true` и отклоняет Supabase transport через заданные 1200 мс. До исправления список ждал 11889 мс, следующий проект — 35494 мс. После исправления initial render — 1289 мс: до первого transport failure параллельно стартовали 9 HTTP calls. Следующие SPA переходы на project/task — 32 / 26 мс, 0 network reads и 0 probes в их assertion windows. Убранный dead transport и online event успешно восстановили server reads. После подтверждённого Data API recovery переход на список занял 192 мс и зарегистрировал 22 reads в assertion window.

Expired-session и fake-online cases изолированы: после проверки offline restoration искусственно изменённый `expires_at` возвращается к исходному значению перед новым fake-online reload. Иначе следующий case проверял бы одновременно transport outage и SDK refresh cooldown. Единичный промежуточный повтор дал 3262 мс на `/projects` при 0 HTTP calls; причина этого выброса не установлена. В финальном полном performance прогоне все 8 offline routes и оба expired-session routes прошли строгий assert <1 секунды. Эти замеры не обещают аналогичных цифр на любом устройстве.

## Проверки и изменённые файлы

`npm test` прошёл: DB connection policy, typecheck, lint без предупреждений, 31 файл / 296 unit tests. Отдельные `npm run typecheck` и `npm run lint` также прошли. `npm run test:sql` прошёл на пересозданной локальной БД. `npm run test:backend` прошёл: Data API/Auth/Realtime, PKCE, двухсессионная конкуренция и HTTP bootstrap (150 отдельных page запросов, контролируемый PT409 и recovery).

Performance browser smoke прошёл с assert <1 секунды для каждого cached offline route, 0 network reads, fake-online fast-path и восстановлением server reads. Воспроизведение: `npm run smoke:offline:performance` (строит production PWA с тестовыми WRITE/SYNC=true только против локального Supabase). `--baseline` использовался до изменения приложения на исходной production сборке.

Полный `npm run smoke:offline:browser` прошёл на финальном коде: cached direct reloads, archived views, templates в new-task form, runtime snapshot старше 60 секунд, offline checkbox/percentage/comment и durable outbox. После reconnect получены ровно 3 server receipts, очередь очищена, финальный server reload показывает изменения. Cross-tab server disable блокирует новую запись и сохраняет ожидающую операцию. Basic/Extended, history, pagination notifications и Extended → Basic offline также прошли.

Последний `npm run build:web` прошёл с исходной конфигурацией: static Expo Web, 35 routes, service worker с 6 precached assets. `EXPO_PUBLIC_OFFLINE_WRITE_ENABLED` и `EXPO_PUBLIC_OFFLINE_SYNC_ENABLED` в обычной конфигурации дают false. Тестовая локальная сборка с true использовалась только в smoke subprocess; `.env` не менялся.

| Команда | Результат |
| --- | --- |
| `npm test` | PASS: 31 файл / 296 тестов, DB policy/typecheck/lint |
| `npm run typecheck` | PASS, повторён после финального кода |
| `npm run lint` | PASS, без предупреждений |
| `npm run test:sql` | PASS, локальная БД |
| `npm run test:backend` | PASS, локальные Data API/Auth/Realtime/PKCE/concurrency/bootstrap |
| `npm run build:web` | PASS, исходная конфигурация и flags OFF |
| `npm run smoke:offline:browser` | PASS, final code |
| `npm run smoke:offline:performance` | PASS, final code, <1 s и 0 HTTP/probes для cached offline routes |
| `git diff --check` | PASS |

Физические устройства и установленная standalone PWA не проверялись. Все browser результаты выше получены в headless Chromium с production static PWA и локальным Supabase; hosted приложение не выкладывалось.

Основные изменённые файлы:

- Connectivity: `src/lib/connectivity/state.ts`, `errors.ts`, `fetch.ts`, `deadline.ts`.
- Supabase/session/query budget: `src/lib/supabase/client.ts`, `session.ts`, `connectivity-probe.ts`, `ui-read.ts`, `realtime.ts`.
- Auth/providers: `src/features/auth/auth.ts`, `AuthProvider.tsx`, `PermissionProvider.tsx`.
- Reads/background work: `src/features/projects/projects.ts`; `src/lib/local-cache/cache.ts`, `repository.ts`, `runtime-config.ts`, `sync.ts`, `bootstrap.ts`, `SyncProvider.tsx`, `OfflineBootstrapProvider.tsx`.
- Regression/smoke: `tests/offline-connectivity.test.ts`, `offline-auth-startup.test.tsx`, `local-cache.test.ts`, `offline-sync.test.ts`, `setup-connectivity.ts`; `vitest.config.mts`; `scripts/offline-navigation-browser-smoke.mjs`, `offline-navigation-instrumentation.js`; `package.json`.
- Этот отчёт: `docs/offline-local-fast-path.md`.

`offline-sync.test.ts` также дожидается background replay, который запускает chooseMine, перед сбросом следующей fixture. Это устраняет межтестовую гонку; production conflict resolution не изменён.

## Git status после реализации, до публикации

Ниже зафиксировано состояние до Git-публикации: все изменения unstaged, `git diff --cached --stat` пуст. `.env`, `.env.example`, package-lock и `supabase/` не менялись. На этом этапе commit, push, deploy и linked database mutations не выполнялись.

```text
 M package.json
 M src/features/auth/AuthProvider.tsx
 M src/features/auth/PermissionProvider.tsx
 M src/features/auth/auth.ts
 M src/features/projects/projects.ts
 M src/lib/local-cache/OfflineBootstrapProvider.tsx
 M src/lib/local-cache/SyncProvider.tsx
 M src/lib/local-cache/bootstrap.ts
 M src/lib/local-cache/cache.ts
 M src/lib/local-cache/repository.ts
 M src/lib/local-cache/runtime-config.ts
 M src/lib/local-cache/sync.ts
 M src/lib/supabase/client.ts
 M src/lib/supabase/realtime.ts
 M tests/local-cache.test.ts
 M tests/offline-sync.test.ts
 M vitest.config.mts
?? docs/offline-local-fast-path.md
?? scripts/offline-navigation-browser-smoke.mjs
?? scripts/offline-navigation-instrumentation.js
?? src/lib/connectivity/
?? src/lib/supabase/connectivity-probe.ts
?? src/lib/supabase/session.ts
?? src/lib/supabase/ui-read.ts
?? tests/offline-auth-startup.test.tsx
?? tests/offline-connectivity.test.ts
?? tests/setup-connectivity.ts
```
