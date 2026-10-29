# TaskTrace: независимое ревью текущих изменений, 29.10.2026

## Baseline и область

Проверен фактический checkout `C:\Users\chupa\proj\TeamTrack`, ветка `main`.
Начальный HEAD и полученный через fetch `origin/main`:
`8ccc15f2d9d57f4405a85872c35c41cc8681eb19` (`feat(ui): add navigation refresh button`).
Указанный в задании `96056cc4436c63de73319b1a30c7beafdf8e53cb` является его родителем.
Локальных коммитов сверх origin не было; staged diff был пуст.

Начальный набор ревью: 29 файлов (27 tracked, включая 4 удаления; 2 untracked).
Полный исходный diff и status сохранены в `.expo/review-2026-10-29/`.

| Группа | Проверенные исходные файлы |
|---|---|
| Workflows | `.github/workflows/ci.yml`, `.github/workflows/release-acceptance.yml` |
| Security/release | `scripts/security-policy.json`, `scripts/security-policy-gate.mjs`, `scripts/security-tooling-conditions.mjs`, `scripts/release-decision.mjs`, `scripts/check-release-workflows.mjs`, `package-lock.json` |
| UI | `src/features/notifications/app-navigation.tsx`, `src/features/notifications/notification-filters.tsx`, `src/app/(app)/projects.tsx`, `src/app/(app)/projects/[id].tsx`, `scripts/audit-fixes-browser.mjs` |
| Тесты | `tests/security-policy-gate.test.mjs`, новый `tests/fixtures/security-risk-audit.json`, удаляемые `tests/security-exception.test.mjs`, `tests/fixtures/security-exception-audit.json`, `tests/fixtures/security-policy-audit.json`, `tests/fixtures/security-policy-legacy-policy.json` |
| Документы | `docs/security-risk-register-2026-10-29.md`, `docs/release/runbook.md`, `docs/release/security-proposal.{json,md}`, `docs/client-error-diagnostics.md`, `docs/audit-followup-2026-10-20.md`, `docs/audit-regression-fixes-2026-10-21.md`, `docs/operation-window-implementation-2026-10-23.md`, `docs/release-readiness-2026-10-18.md` |
| Отдельный локальный артефакт | `src/types/database.types.ts` |

Последний файл содержит таблицу `followup_upgrade_ids` из SQL upgrade fixture.
Это результат генерации типов тестовой БД, а не изменение прикладной схемы.
Начальные байты сохранены; этот diff исключается из доставки.

Дополнительно изменены `scripts/security-export.mjs`, `src/components/ui/button.tsx`,
`scripts/client-error-browser-integration.mjs`, `tests/ci-coverage.test.mjs` и этот отчёт.
Итого рассмотрены 34 изменённых файла; 33 относятся к доставке, один локальный diff типов исключён.
Независимо прочитаны связанные export,
database/browser harness, hosting hold, manifest и runbook; прежние отчёты не
использовались как доказательство успешных проверок.

## Подтверждённые дефекты и исправления

| ID / severity | Файл | Причина, воспроизведение и последствие | Исправление / регрессия |
|---|---|---|---|
| R01 High | `scripts/security-policy-gate.mjs` | `npm_config_omit=dev` с `npm_config_audit_level=critical` превращал полный audit в отчёт с 8 entries и exit 0 вместо 10 / exit 1. Новый неизвестный dev-risk мог скрыться. | Явные include prod/dev/optional/peer, audit-level=info, отключение workspace-фильтра. Повторный реальный audit с теми же настройками: 10 entries / exit 1. Проверяется контракт аргументов; исходные stdout/stderr сохраняются. |
| R02 High | `scripts/security-policy-gate.mjs`, `scripts/security-policy.json` | Граф не учитывал peerDependencies. Новый root с peer zod получал принятие вне рассмотренных путей. | Учёт установленных peer edges; явный список существующих Expo peer roots в кодовом каталоге и JSON. Новый peer root блокируется регрессионным тестом. |
| R03 High | `scripts/security-policy-gate.mjs` | Проверялись только перечисленные audit nodes. Дополнительная вложенная установка не обнаруживалась; смена уязвимой версии или кода consumer могла сохранить прежний статус. | Обход реального module tree, проверка alias/версий/отсутствующих nodes, отказ на symlink. Уязвимые версии привязаны к рассмотренному каталогу. Пять установленных исходников Expo/config/Workbox/resolver на принятых call paths требуют пересмотра при изменении. Тесты extra install, symlink, version и call-path drift. |
| R04 High | `scripts/security-tooling-conditions.mjs`, `scripts/check-release-workflows.mjs` | Наличие строки команды не гарантировало её исполнение: if=false, continue-on-error, `|| true`, пропущенные backend checks, другой checkout и dotenv overrides проходили старые controls. | Обязательные команды и порядок, условия и Node runtime, матрица 22/24, триггеры, exact event SHA, источник outputs и needs; закрытый список команд на этой границе. Шесть отрицательных workflow-сценариев. |
| R05 High | `.github/workflows/release-acceptance.yml`, `scripts/release-decision.mjs` | Decision начал импортировать gate с yaml/semver, но job не устанавливал зависимости: receipt не мог быть создан на чистом runner. Security outputs также не содержали проверенный SHA. | Pinned setup-node + npm ci перед decision. Gate возвращает реальный git HEAD; receipt сверяет его с SHA decision checkout. Tests: чистый job, другой SHA, failure/skipped/cancelled/in_progress обязательных jobs. |
| R06 High | `scripts/security-policy-gate.mjs` | Изменение package severity, ложная via-связь с известным advisory и совместимый root fix не приводили к пересмотру. | Сопоставление severity с рассмотренным advisory graph и via с lock edges; канонический GHSA URL; совместимый npm root fix блокирует принятие. Отрицательные тесты severity, via и available fix. |
| R07 High | `scripts/security-policy-gate.mjs` | Валидная source map с sourceRoot=`node_modules/zod/` и sources=`index.js` скрывала пакет от проверки. | Проверяется полный путь sourceRoot + source. Регрессионная карта с Zod отклоняется. |
| R08 Medium | `scripts/security-export.mjs`, `scripts/security-tooling-conditions.mjs`, `scripts/security-policy-gate.mjs` | Provenance снимался после сборки; конкурентная правка могла подписать старый bundle новыми входами. Build flags вообще не были связаны с evidence. | Снимок исходников до сборки и проверка после; отдельный hash EXPO/NODE_ENV/BABEL_ENV входов и сверка gate. Tests: правка во время exporter callback и смена публичного флага после экспорта. |
| R09 Medium | `scripts/security-policy-gate.mjs` | После устранения одного риска runGate загружал только активные metadata, но verifyUpstream требовал все accepted записи. Частичное исправление ошибочно давало FAIL. | Upstream проверяется только для активных advisory. Частичное устранение Zod при оставшемся deepmerge покрыто тестом. |
| R10 Medium | `src/components/ui/button.tsx`, `scripts/audit-fixes-browser.mjs` | На checklist при effective width 160 (320 / 200%) кнопка «Детали» имела clientWidth=36, scrollWidth=42, хотя весь документ оставался 160/160. Прежний тест пропускал обрезание. | Текст кнопки получает minWidth=0; матрица дополнительно проверяет внутреннее переполнение кнопок. Навигация проверяется через trial click. |
| R11 Low | `docs/security-risk-register-2026-10-29.md`, `scripts/security-policy.json` | Документ противоречил сам себе по числу тестов и утверждал отсутствие deepmerge call site в Workbox. Фактически resolver вызывает `deepMerge({}, defaults)`. | Уточнены фактические результаты и область: merge выполняется с собственными константными defaults, без attacker-controlled JSON/null target. Эти установленные call paths теперь контролируются. |
| R12 High | `scripts/release-decision.mjs` | Helper принимал clean PASS при заведомо уязвимом текущем lock, а для accepted статуса проверял только принадлежность ID реестру, позволяя пропустить активное advisory. Совпадение хешей само по себе этого не предотвращало. | Дополнительная независимая сверка точного набора active IDs с известными affected lock nodes. Возврат remediated advisory, ложный clean и неполный accepted список отклоняются; настоящий clean тест использует исправленный lock. |
| R13 Medium | `scripts/client-error-browser-integration.mjs` | Между удалением snapshot и кликом фоновое чтение могло восстановить cache. Клиент успешно сохранял запись без ошибки, а тест ошибочно ждал диагностическое событие (captured=0). | Одноразовое удаление тестового snapshot непосредственно перед чтением в реальной enqueue transaction и обязательная проверка выполнения fault. Ожидания реального восстановления, HTTP-доставки, privacy и quota не ослаблены; прикладной код не менялся. |

Исходные воспроизведения 12 отказов сохранены в `security-reproductions.log`.
Новый trial-click первоначально имел неоднозначный локатор двух кнопок
«Обновить»; он исправлен на уникальную accessibility label навигации. Это была
ошибка теста, а не основание скрывать отказ первого acceptance.

Нет подтверждённых оставленных Critical/High-дефектов в области изменений.
При этом read-only unsigned tooling scope не является разрешением на signing,
сетевой DevTools или произвольное privileged CI. Владельцы исходников workflow
и самого gate остаются доверенной границей review; JSON policy сама по себе
не может расширить принятые ID/версии/severity/ranges/roots/measures.

## Реестр рисков

- node-forge 1.4.2: `GHSA-86w9-cpqp-85rv`, remediated; в полном текущем audit отсутствует.
- Zod 3.25.76: `GHSA-mrhx-c7xc-m3w5`, High, accepted только для рассмотренного tooling scope; фиксированная 4.6.6 несовместима с текущими consumer ranges.
- deepmerge 4.3.1: `GHSA-gcqx-w48m-w2h4`, Low, accepted для проверенных Expo/config и Workbox call paths; patched release отсутствует.
- Любой новый ID любого severity, изменение диапазона/severity, новый root, совместимое исправление, изменённая уязвимая версия/call path, bundle exposure или утрата controls блокируют gate.
- В исполняемой policy и decision нет календарного expiry. Старые proposal-файлы оставлены как явно помеченная история, без ссылок на них из исполняемого решения.
- Raw audit остаётся FAIL: 3 High + 7 Low package entries, два advisory. Не изменяется и не фильтруется ради PASS.

## Учёт тестов

Количество получено реальной Vitest collection (`--no-staticParse`) из архива
точного baseline, а не поиском `it()` по исходникам:

| Набор | 96056cc | Проверенная реализация |
|---|---:|---:|
| Все тесты | 1145 | 1109 |
| Старое временное exception | 62 | 0 |
| Security policy gate | 49 | 56 |
| Navigation refresh, уже в текущем HEAD | 0 | 19 |

Арифметика: 1145 − 62 − 49 + 56 + 19 = 1109. Прочие test files и Vitest
exclusions не изменены. Начальное рабочее дерево независимо прошло 1080 тестов.
Новые сценарии проверяют реальные отрицательные условия; фиктивные тесты для
сохранения счётчика не добавлялись. Строковая проверка старой формы exporter
заменена проверкой поведения: forbidden credential отклоняется до запуска CLI.

## Доказательства и завершение

Фактические логи, результаты и screenshots хранятся в `.expo/review-2026-10-29/`,
`.expo/release-acceptance/`, `.expo/security-policy/`, `.expo/audit-fixes/` и
в штатных evidence-каталогах соответствующих suites. Они не включаются в Git.
Первый полный acceptance дал 17/18 из-за локатора нового теста; его журнал
сохранён отдельно как `acceptance-first-run.json` и не подменяет итоговый прогон.

Финальные локальные результаты:

| Проверка | Результат |
|---|---|
| npm ci | PASS, lock воспроизводим |
| npm test / TypeScript / ESLint | PASS, 91 файл / 1109 тестов |
| Security regression tests | PASS, 56 gate tests; CI coverage дополнительно 3 |
| SQL fresh / upgrade / advisors / protocol | PASS, в полном acceptance |
| Backend / Auth / PKCE / concurrency / Realtime / CAS / RLS | PASS, отдельный интеграционный прогон |
| Chromium и WebKit responsive | PASS, по 173 измерения; 11 групп сценариев на engine |
| PWA / SW / storage / offline / crash / load / GC | PASS |
| Web + Android + iOS unsigned export / source maps | PASS |
| Bundle exposure | PASS, принятые tooling packages отсутствуют |
| Expo Doctor | PASS, 21/21 |
| Полный raw npm audit | FAIL, 3 High + 7 Low entries, 2 рассмотренных advisory |
| Security Policy Gate | PASS WITH ACCEPTED RISKS |
| Release Acceptance | PASS, 18/18; owned container removed |
| Локальная Edge диагностика | PASS на Chromium и WebKit, 24 тестовые записи, quota/privacy/recovery |
| git diff / manifest / secret-pattern scan | PASS, нет добавленных секретов/бинарных файлов/production config |

Удалённые GitHub receipts проверяются отдельно для итогового SHA доставки.
Локальное создание JSON receipt не используется как замена CI. Даже зелёные
CI/security/acceptance не закрывают независимые production условия ниже.

## Ограничения production и будущий rollout

Автопубликация Timeweb перед push подтверждена владельцем как выключенная;
активность GitHub webhook отдельно проверена read-only. `vercel.json` сохраняет
git.deploymentEnabled=false и hosting hold. Настройки провайдеров не менялись.
Push и успешный acceptance не разрешают production rollout.

Перед отдельным production этапом:

1. Сверить реальные migration history и definitions с reviewed планом. Указанную владельцем уже применённую `20261028142906_client_error_diagnostics.sql` проверить чтением; повторно не применять вслепую. Старый snapshot preflight не считать доказательством текущей схемы.
2. Подтвердить Supabase grants/RLS, выключенную клиентскую диагностику до готовности backend, Cron/retention и квоты. Проверить backup/restore, server protocol/policies и совместимый rollback согласно runbook.
3. Через защищённые средства настроить серверные `CLIENT_ERROR_DB_URL` и при необходимости CA, точный `CLIENT_ERROR_ALLOWED_ORIGINS`. Не переносить эти секреты в EXPO_PUBLIC или логи.
4. После отдельного разрешения опубликовать `client-errors`. Проверить отказ без пользовательского JWT, Auth, TLS с проверкой сертификата и заранее разрешённую canary-доставку.
5. Включить `EXPO_PUBLIC_CLIENT_DIAGNOSTICS_ENABLED=true`, задать неизменяемый build ID и собрать production artifact точного прошедшего CI SHA с актуальной публичной конфигурацией и свежими evidence.
6. После server/config и hosting checks опубликовать на Timeweb отдельным разрешённым действием. Проверить PWA/SW и Android/iOS на реальных устройствах, offline drafts, outbox/reconnect и доставку диагностических событий.
7. Наблюдать ошибки, quota/retention/DB size и состояние sync. Проверить rollback совместимым artifact или отключением диагностического флага следующей сборкой; пользовательские storage/outbox/receipts не очищать.

В этой задаче production deployment, hosted migrations, публикация Edge
Functions и изменения пользовательских данных не выполняются.
