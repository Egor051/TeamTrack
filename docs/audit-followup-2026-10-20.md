# Исправления аудита TaskTrace от 20.10.2026

> Исторический отчёт. Его описание временного security-исключения и хеш-закреплённой политики заменено постоянным реестром и текущими проверками в [security-risk-register-2026-10-29.md](security-risk-register-2026-10-29.md); приведённые ниже статусы относятся к исходной дате.

Этот отчёт отражает предыдущий этап. Итоги независимого аудита и последующих исправлений, актуальные контракты legacy RPC, fingerprints и ограничения выпуска приведены в [отчёте от 21.10.2026](audit-regression-fixes-2026-10-21.md).

Реализация и проверки завершались 20–21.10.2026 в локальном checkout `C:\Users\chupa\proj\TeamTrack`. Исходный HEAD: `3f33f4540cf383e3846e62ebd97309247f835704`.

## 1. Результат

Из исходных 15 пунктов: **14 FIXED, 1 PARTIAL, 0 NOT FIXED**. Все 12 функциональных дефектов исправлены. OTHER-03 остаётся PARTIAL: исправленных upstream-релизов для двух исходных advisory нет. Их ограниченное исключение сохранено до **25.10.2026 23:59 UTC+3**. Это не чистый security audit.

Commit, push, production deployment и применение миграции к production не выполнялись. SQL/API/Auth/Realtime проверки использовали отдельные временные базы и синтетические аккаунты. Существующие данные локального приложения не сбрасывались.

## 2. Статус каждого пункта

| ID | Статус | Причина | Реализованное исправление | Подтверждение |
| --- | --- | --- | --- | --- |
| BUG-01 | FIXED | Фоновая загрузка заменяла серверную строку без сохранения версии, с которой начат ввод; онлайн RPC не проверяли её | Отдельная исходная версия черновика комментария, процента и названия; явное принятие новой версии; обязательная версия для поддерживаемых правок; новые CAS-перегрузки RPC; все редактируемые поля увеличивают существующий sync_version | UI-регрессии комментария/процента/названия; SQL PT409; настоящий PostgREST; браузерный сценарий Broadcast → сохранённый черновик → разрешение конфликта → CAS |
| BUG-02 | FIXED | Offset-страницы читались из изменяющегося набора без общего revision | Snapshot RPC использует блокировку существующего commit-ordered feed; проверяются revision, total, offset, длина и уникальность; PT409 отбрасывает всю попытку; не более трёх попыток | Unit delete/archive/reorder на 501 записи; HTTP: архивирование первой записи между страницами даёт PT409, повтор сохраняет Item 501 |
| BUG-03 | FIXED | Видимость аудита зависела от уже удалённой task_items строки | Закрытая таблица соответствия item → task/project; backfill из существующих строк и доверенных снимков аудита; новые события получают task_id; RLS проверяет текущий доступ к сохранившемуся этапу | Upgrade fixture с ранее удалённым пунктом и старым комментарием без task_id; SQL/HTTP: история доступна участнику, недоступна постороннему и после отзыва членства |
| BUG-04 | FIXED | Индивидуальный role_override продолжал ограничивать нового владельца | Атомарный сброс переопределений получателя перед передачей владения, включая архивные этапы; сохранение is_direct и запись аудита | SQL: effective role нового владельца owner; сброс viewer отражён в audit_log; существующие тесты сериализации передачи владения |
| BUG-05 | FIXED | Не все Auth/mutation запросы имели предел ожидания; потерянный ответ делал повтор создания небезопасным | Общий fetch ограничивает Auth 5 с и Data API 20 с, включая тело; ограничен SDK signOut; онлайн-мутации сохраняют operation_id до отправки и используют существующие server receipts; одинаковый повтор/reload получает прежний результат; изменённая форма сначала уточняет прежнее действие | Unit зависших POST/PUT/Auth/SDK/REST, перезапуска модулей и потерянного ACK; конкурентный HTTP replay создаёт одну запись; браузерная проверка exactly-once replay |
| BUG-06 | FIXED | PWA снимала таймер после заголовков, до готовности HTML | Таймер и явное отклонение Promise действуют до чтения полного клона тела; ошибка идёт в существующий precache fallback | Chromium и WebKit: зависание до заголовков и после частичного HTML; fallback за 5,08–5,38 с, обновление перезагружает приложение один раз, page errors отсутствуют |
| BUG-07 | FIXED | pending удерживался не завершающимся membership запросом | Ограничены весь цикл и отдельные чтения; AbortController и generation исключают поздние результаты; reconnect отменяет старую проверку и запускает новую | Unit: тайм-аут освобождает pending; reconnect завершает новую проверку, поздний ответ старой игнорируется; прежняя coalescing-регрессия проходит |
| BUG-08 | FIXED | После PT409 редактор сохранял старую версию, повторяя конфликт | Авторитетное чтение пункта после конфликта; выбранная дата остаётся в том же экземпляре picker; явное принятие новой версии перед повтором | UI: первая попытка v1 → PT409 → сохранённая дата → принятие v2 → успешная повторная отправка той же даты |
| BUG-09 | FIXED | Скопированный description был в БД, но отсутствовал в представлении рабочего пункта | Описание отображается в раскрытых деталях пункта; копирование остаётся независимым от шаблона | UI-проверка видимых инструкций; SQL/HTTP bulk-copy сохраняет description |
| BUG-10 | FIXED | Windows .cmd повторно интерпретировал PostgreSQL URL | npx-cli.js запускается через Node с массивом argv без cmd.exe; добавлен timeout; URL маскируется при ошибке | Дочерний процесс на Windows получает неизменный URL с &, %, кавычками и параметрами; явная ошибка при отсутствии npm entry point; не-Windows путь сохранён |
| BUG-11 | FIXED | Переключатель архив/активные исчезал при потере права управления | Переключатель доступен пользователям с доступом к этапу; управляющие действия по-прежнему ограничены ролью | UI-регрессия: администратор открывает архив, роль понижается, возврат к активным остаётся доступен |
| BUG-12 | FIXED | Загрузка дневного прогресса не зависела от смены календарного дня | Общий UTC+3 day hook, таймер границы суток, AppState/focus/visibility; оба экрана скрывают данные предыдущего дня немедленно и перечитывают текущие | Unit: точная полночь UTC+3, возврат native приложения после приостановки/изменения часов; очистка таймеров; существующие offline/progress тесты |
| OTHER-01 | FIXED | Полный JSON и hash набора пересоздавались на каждой странице | Маленькая revision/count таблица с триггерами; SQL LIMIT; индексируемый keyset; точность numeric cursor сохраняется строкой; старый page RPC делегирует новому | HTTP 1001 уникальная упорядоченная запись; клиентские revision-регрессии; legacy-пагинация и preview на 0/1/999/1000/1001/2001/5001 записях |
| OTHER-02 | FIXED | Построчное копирование запускало агрегацию растущего чек-листа после каждой вставки | Один INSERT SELECT; триггеры с transition tables пересчитывают статус один раз на затронутый этап и SQL statement; аудит/feed/Broadcast остаются активны | Копирование 1001 записи: 495 мс в отдельном прогоне; legacy сценарий 5001 записи сохраняет порядок/описания; SQL проверяет итоговый статус; существующие fanout/concurrency тесты |
| OTHER-03 | PARTIAL | braces 3.0.3 и node-forge 1.4.0 имеют действующие advisory без patched release | Перепроверены npm-цепочки, официальные advisory, latest и bundle maps; сохранено только прежнее исключение с тем же сроком. Дополнительно обнаруженные advisory Vite устранены обновлением 8.3.1 → 8.3.3 | Итоговый raw npm audit FAIL: 18 HIGH/meta findings от двух исходных корней; policy PASS WITH APPROVED EXCEPTION; новые Vite advisory отсутствуют |

## 3. Контракты и архитектура

Новая миграция: `supabase/migrations/20261020194125_audit_followup_integrity_and_scaling.sql`. Ранее применённые миграции не изменялись. Типы заново сгенерированы Supabase CLI из мигрированной временной базы.

Существующие runtime-state/coordinator, outbox v2, разрешение конфликтов, cache driver, Realtime и RLS остаются владельцами соответствующего состояния. Второй provider, sync loop или очередь офлайн-редактирования не создавались.

Онлайн executor добавляет устойчивую идентичность запросов в существующий cache driver (`sync:mutation:*`) и использует существующую `private.client_operation_receipts`. Сохраняются только отправляемые онлайн-действия. Сеть сама не повторяет неизвестный результат новым operation_id. Браузерные вкладки используют Web Locks; активные вызовы в одном процессе объединяются. Server RPC выбирает только явно разрешённые функции, проверяет сигнатуру и EXECUTE, затем выполняет исходные авторизованные RPC в одной транзакции с receipt. Доступ anon/service_role к этому RPC закрыт.

При проверке связанного пути дополнительно закрыт случай неясного HTTP-результата: proxy 408/500, ошибка разбора ответа со status 0 и повреждённый успешный ответ сохраняют прежний operation_id. Известный SQLSTATE доказывает rollback и остаётся авторитетной ошибкой. Три дополнительные регрессии подтверждают безопасный повтор после таких ответов.

Старые RPC-сигнатуры сохранены для совместимости. Обновлённый клиент использует обязательную CAS-версию. Старые уже установленные клиенты не приобретают новый интерфейс разрешения конфликтов автоматически: перед приёмкой нужно завершить обновление PWA/клиентов. Дополнительные поля теперь увеличивают sync_version, поэтому старое неподтверждённое изменение безопасно попадёт в существующий конфликт при конкурентной правке этих полей.

Snapshot использует существующую глобальную блокировку feed. При постоянных конкурентных изменениях загрузка может завершиться ошибкой после трёх попыток; неполный результат не публикуется. Производственные задержки глобальной блокировки при реальной нагрузке здесь не измерялись.

Пагинация шаблонов считает revision и total через служебные метаданные. Данные страниц ограничены SQL LIMIT; новый клиент передаёт keyset. Legacy offset-контракт остаётся рабочим, но новые клиенты не сканируют пропущенные страницы повторно.

## 4. Зависимости и остаточный риск

Исходные цепочки:

- `expo → @expo/metro → metro-file-map → micromatch → braces@3.0.3`.
- `expo → @expo/cli → node-forge@1.4.0`, также через `@expo/code-signing-certificates`.

На 21.10.2026 официальные advisory указывают отсутствие patched versions: [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Registry latest совпадает с установленными версиями. Совместимый безопасный upstream-переход не найден. Предложенный npm audit откат Expo/RN на прежние major-версии не является совместимым исправлением текущего SDK.

Во время финального live-аудита добавились три advisory встроенного launch-editor в `vitest → vite@8.3.1`: [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm). Gate остановил проверку. Добавлен точный override Vite 8.3.3, допустимый peer-контрактом Vitest; lockfile меняет только Vite и его declared range для уже установленного rolldown. После обновления все три advisory исчезли из raw audit.

Политика не расширена: ровно два прежних GHSA, тот же audit graph и срок. После проверки минимального dependency diff обновлены только manifest/lock fingerprints и пояснение основания пересмотра. Автоматического обновления fingerprints или срока нет. Guard-тесты по неизвестному advisory, изменённому графу/lock, доступности upstream-fix, истечению срока и включению пакетов в bundle продолжают действовать.

Финальные fingerprints:

- Lock SHA256: `34d68652ffde85a733e2a4b80ac97b7d639eda36cb40e7598abf83c2f043893f`.
- Manifest SHA256: `8c91159135f934bc36ad0ab1db3faae3dabad6ca340b43e2479c76ddcfdb04d5`.
- Audit graph SHA256: `f63bae014c20184286168ba194c63e8db5f18fe81f5bcd7378ba565e6f9a8f90`.

Raw npm audit: **FAIL, 18 HIGH, 0 CRITICAL**, в том числе meta findings; это не 18 независимых root advisory. Policy: **PASS WITH APPROVED EXCEPTION** до `2026-10-25T20:59:00.000Z`. Проверка source maps web/Android/iOS не обнаруживает braces/node-forge в клиентских bundles. Остаточный риск относится к инструментам разработки/сборки и не устранён отсутствием этих модулей в клиенте.

## 5. Выполненные проверки

Среда: Windows, Node 24.15.0; CI по-прежнему задаёт Node 22. Проверки выполнялись установленными инструментами. Отдельная локальная проверка под Node 22 не проводилась.

| Команда / группа | Фактический результат |
| --- | --- |
| `npm test` | PASS: connection policy, TypeScript, lint, 72 файла / 838 unit/component тестов; финальный повтор после обновления Vite и обработки неопределённого HTTP-результата |
| `node scripts/run-audit-sql-tests.mjs --fresh --cron --advisors` | PASS: полная fresh-цепочка миграций, 17 SQL suites, конкурентные API-сценарии, реальный pg_cron; три upgrade-only suites явно неприменимы к fresh |
| `node scripts/run-audit-sql-tests.mjs --advisors` | PASS: upgrade из предыдущей схемы с legacy fixtures, все 20 SQL suites и API-регрессии |
| `--fresh --generate-types audit_followup_test.sql` | PASS: новые регрессии и генерация типов из мигрированной временной БД |
| `node scripts/audit-followup-integration.mjs` | PASS: настоящий PostgREST, snapshot 501, CAS, concurrent receipt replay, keyset/copy 1001, история и revoke |
| `node scripts/run-audit-remediation-tests.mjs` | PASS: границы 0/1/999/1000/1001/2001/5001, legacy paging, PT409/retry, preview/copy, ACL и concurrent CAS |
| `node scripts/verify-audit-regressions.mjs` | PASS: отрицательные контроли действительно ломаются с прежней RLS/без Broadcast и проходят после восстановления |
| `node scripts/test-security-hardening.mjs` | PASS: 57 исходных RPC, 646 сценариев, включая 70 concurrency, quota/ACK/ownership |
| `node scripts/test-security-hardening.mjs --hosted` | PASS: та же матрица на **восстановленной fixture во временной локальной БД**, не проверка production |
| `node scripts/run-security-integrations.mjs` | PASS: Data API/Auth/Realtime, web/native PKCE, две SQL-сессии, bootstrap HTTP, password Auth, lifecycle/revoke и template Broadcast security |
| Isolated runner: `audit-remediation-browser`, `template-realtime-browser`, `connectivity-recovery-browser-smoke` | PASS: настоящий браузер и отдельный Auth/PostgREST/private Broadcast; 2 remediation-сценария, 7 template-групп, 6 connectivity-сценариев |
| `node scripts/pwa-mobile-browser-smoke.mjs` | PASS: Chromium и WebKit, обрыв/зависший HTML body, cached shell, update/reload; это браузерные профили, не физические телефоны |
| `npm run build:web` | PASS: 35 routes, service worker и precache |
| Expo export web + Android + iOS с source maps | PASS: все платформы экспортированы; это не запуск native-сборок на устройствах |
| `npx expo-doctor` | PASS: 21/21 |
| `security-policy-gate.mjs --bundles .expo/security-export` | Raw audit FAIL; policy PASS WITH APPROVED EXCEPTION после исправления Vite |
| Supabase security advisor SQL | 0 ERROR; 72 WARN authenticated SECURITY DEFINER RPC и 10 INFO RLS-enabled private tables без клиентских policies; не заявляется нулевое число предупреждений |
| `git diff --check` | PASS |

Первичные прогоны выявляли старые ожидания тестов (title не увеличивает версию; единственная RPC-сигнатура), mocks прежних page RPC и TS-ошибку поиска mocked компонента. Они исправлены под новый проверяемый контракт, без удаления проверок ACL/CAS. Финальные прогоны проходят. Отдельно сохранён результат первого свежего policy FAIL на новых Vite advisory и последующего исправления; raw audit остаётся FAIL по двум исходным исключениям.

Локальные текстовые доказательства: `C:\tmp\teamtrack-audit-20261020\` — `npm-test-final-followup.log`, `sql-fresh-followup-final.log`, `sql-upgrade-followup-2.log`, `followup-http.log`, `audit-remediation-followup.log`, `negative-controls-followup.log`, `security-fresh-followup.log`, `security-upgrade-followup.log`, `backend-integrations-followup.log`, `browser-integrations-followup.log`, `pwa-followup.log`, `build-followup.log`, `export-final-followup.log` (первый FAIL на новых Vite advisory), `policy-final-followup.log`, `export-policy-final-followup.log` (финальный export/gate), `expo-doctor-followup.log`. Машинные security evidence и raw audit: `.expo/security-evidence/`, `.expo/security-policy/` (ignored build evidence).

## 6. Действия перед production

1. Проверить актуальный upstream/audit и срок исключения. После истечения срока gate обязан блокировать выпуск до проверенного исправления или отдельного решения владельца.
2. После отдельного разрешения сначала применить новую миграцию к целевой БД, затем выпустить клиент: он использует новые CAS/snapshot/page/envelope RPC. Проверить backfill и миграционный lock_timeout на staging-копии производственного объёма. Старые сигнатуры не удалены.
3. Завершить обновление установленных PWA/клиентов; проверить concurrent draft/CAS и неизвестный результат мутации на целевом окружении.
4. Проверить на физических Android/iOS: Wi-Fi half-open, зависший Auth/HTML, восстановление без reload, UTC+3 midnight/возврат из background и service-worker update. Браузерная WebKit/Chromium проверка не заменяет это.
5. Измерить реальные размеры/нагрузку: новая snapshot-пагинация использует глобальную feed-блокировку. Локальные 1001/5001 записи подтверждают устранение избыточной работы, но не дают production SLO.

Все 12 багов и две проблемы производительности устранены в локальном коде и миграции; известных проваленных функциональных регрессий в выполненных проверках нет. Утверждать, что устранены все 15 рисков, нельзя: два исходных upstream advisory остаются под временным исключением. Production и физические устройства в этой работе не валидировались.

## 7. Полный список изменённых файлов

Все пути ниже относительно `C:\Users\chupa\proj\TeamTrack`. `new` означает новый файл. Всего 53 файла: 39 изменённых и 14 новых.

```text
.github/workflows/ci.yml
package.json
package-lock.json
scripts/gen-types.mjs
scripts/generate-service-worker.mjs
scripts/pwa-mobile-browser-smoke.mjs
scripts/run-audit-sql-tests.mjs
scripts/sql-test-suites.mjs
scripts/security-policy.json
scripts/package-runner.mjs                                      new
scripts/audit-followup-integration.mjs                          new
src/app/(app)/projects/[id]/progress.tsx
src/app/(app)/projects/[id]/tasks/[taskId].tsx
src/app/(app)/projects/[id]/tasks/[taskId]/progress.tsx
src/components/ui/deadline-picker.tsx
src/features/auth/PermissionProvider.tsx
src/features/auth/auth.ts
src/features/notifications/notifications.ts
src/features/projects/projects.ts
src/features/projects/template-pages.ts
src/lib/connectivity/fetch.ts
src/lib/errors/user-message.ts
src/lib/local-cache/edit.ts
src/lib/local-cache/sync.ts
src/lib/local-cache/snapshot-pages.ts                           new
src/lib/local-cache/use-current-day.ts                          new
src/lib/supabase/ui-read.ts
src/lib/supabase/mutation.ts                                    new
src/types/database.types.ts
supabase/migrations/20261020194125_audit_followup_integrity_and_scaling.sql new
supabase/tests/offline_pull_conflicts_test.sql
supabase/tests/rls_and_rpc_test.sql
supabase/tests/audit_followup_test.sql                          new
supabase/tests/audit_followup_upgrade_fixture.sql               new
supabase/tests/audit_followup_upgrade_test.sql                  new
tests/connectivity-recovery.test.ts
tests/notification-count-cache.test.ts
tests/offline-auth-identity.test.ts
tests/offline-connectivity.test.ts
tests/offline-outbox.test.ts
tests/offline-phase6-runtime.test.ts
tests/offline-sync.test.ts
tests/permission-provider-cache.test.tsx
tests/task-enhancements.test.ts
tests/task-screen-loading.test.tsx
tests/template-list-cache.test.ts
tests/template-mutation-contract.test.tsx
tests/template-pages.test.ts
tests/current-day.test.tsx                                     new
tests/online-mutation.test.ts                                  new
tests/package-runner.test.mjs                                  new
tests/snapshot-pages.test.ts                                   new
docs/audit-followup-2026-10-20.md                               new
```
