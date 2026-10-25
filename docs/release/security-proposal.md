# F06: дополнительные advisory устранены, временное исключение активировано

Проект: `C:\Users\chupa\proj\TeamTrack`. Этап IMPLEMENTATION + VERIFICATION, 25.10.2026.

**Raw npm audit: FAIL — 5 HIGH, 0 MODERATE, 0 LOW, 0 CRITICAL. Security gate: PASS WITH APPROVED EXCEPTION. F06: CLOSED WITH TEMPORARY EXCEPTION. Production release: HOLD.**

Исключение действует **с 2026-10-25T10:32:09.000Z до 2026-11-08T10:32:09.000Z**, ровно **1 209 600 000 ms / 14 суток**. В момент expiry gate возвращает FAIL. Это временное принятие двух рисков, а не исправление двух оставшихся уязвимостей и не утверждение полной безопасности приложения.

Основание — явное решение владельца в заданиях `282cee6b-fd99-4fc2-b61a-a39ebe323c87` и `388a3e23-7ac1-4bfa-af74-7e4eb655173e`. Использован поддерживаемый контракт `policyVersion: 1` с `approvalReference` и отдельным строго определённым профилем. Имена, подписи и номера утверждения не выдуманы. Старая дата expiry не наследовалась; первоначальные документы и policy сохранены в evidence.

## Обновления зависимостей

| Пакет | Было → стало | Родитель и разрешённый диапазон | Совместимость |
| --- | --- | --- | --- |
| fast-uri | **3.1.8 → 3.1.9** | Workbox 7.4.1 → AJV 8.20.0, `^3.0.1` | Patch той же ветки, semver constraint выполнен |
| serialize-javascript | **7.1.2 → 7.1.4** | Workbox 7.4.1 → @rollup/plugin-terser 1.0.0, `^7.0.3` | Выбран более новый безопасный patch; Node `>=20`, проверены Node 22/24 |

Обычного точечного обновления lockfile оказалось достаточно: **ровно две package records изменились**. Overrides не добавлялись. Expo **57.0.31**, CLI **57.0.32**, React Native **0.86.3**, Workbox **7.4.1**, остальные dependency versions и прежние overrides сохранены. В package.json изменены только команды запуска/export для компенсирующих мер.

Устранены и отсутствуют в свежем raw audit:

- [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg).
- [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h).
- [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr).
- [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp).
- [GHSA-m5mm-p8h7-m29v](https://github.com/advisories/GHSA-m5mm-p8h7-m29v).

Registry metadata и GitHub advisories проверены заново. Для fast-uri последняя совместимая ветка 3 — 3.1.9; для serialize-javascript ветка 7 — 7.1.4. Nested уязвимых копий не осталось. `npm ls --all`, `npm explain` и чтение реальных package.json подтверждают версии/пути. Gate теперь проверяет физически установленные пакеты, а не доверяет только скрытому индексу npm.

Первый `npm install` после изменения lockfile оставил старые файлы при обновлённом `node_modules/.package-lock.json`. Это обнаружено чтением package.json. Полный `npm ci` восстановил точное дерево; отдельный чистый `npm ci` воспроизвёл его с теми же hashes и версиями. Результаты аудита до фактической установки не использованы как достаточное доказательство исправления.

## Оставшийся raw audit

| Package entry | Версия | Severity | Корневая причина |
| --- | --- | --- | --- |
| expo | 57.0.31 | HIGH | Производная через CLI |
| @expo/cli | 57.0.32 | HIGH | Производная через node-forge / signing certificates / zod |
| @expo/code-signing-certificates | 0.0.6 | HIGH | Производная через node-forge |
| node-forge | 1.4.0 | HIGH | GHSA-86w9-cpqp-85rv |
| zod | 3.25.76 | HIGH | GHSA-mrhx-c7xc-m3w5 |

Итого **5 package entries, ровно 2 корневых advisory**. Настоящий raw `npm audit` exit code — **1**, включая чистое тестовое окружение. Итоговый CLI gate exit code — **0**, поскольку выполнены условия утверждённого исключения. Эти результаты хранятся раздельно; raw JSON не фильтруется и не переписывается.

[node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv): диапазон `<=1.4.0`, official patched version отсутствует, registry latest — 1.4.0. Остаточный риск касается корректности RSA/certificate/CSR verification в tooling. Установленный Expo tooling действительно содержит соответствующие verify API; их наличие не означает установленный внешний путь эксплуатации приложения.

[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): диапазон `<4.6.6`, исправление 4.6.6, latest 4.6.7. CLI требует `^3.25.76`; последняя стабильная ветка 3 остаётся 3.25.76. В DevTools schemas есть коллекции без общей верхней границы; чрезмерный объём некорректного ввода может расходовать память. Подмена на Zod 4 не выполнялась.

Последние стабильные Expo/CLI ветки 57 совпадают с установленными. Registry также содержит Expo 58.0.19 / CLI 58.1.15, но CLI 58 всё ещё объявляет Zod 3 и node-forge. Непроверенный major upgrade SDK не является подтверждённым исправлением. Для окончательного устранения нужны официальный исправленный node-forge и поддерживаемый Expo CLI с совместимым исправленным Zod, затем обычная повторная приёмка.

## Условия принятого риска и экспозиция

Область исключения — **проверенный isolated unsigned static export**, включая экспорт JavaScript Web/Android/iOS. Внешние привилегированные EAS/signing процессы и сетевой DevTools не включены в согласие. Их параметры и секреты не исследовались и не менялись.

Действующие меры реализованы и проверены:

1. Один `security-export.mjs` используется web build, обоими CI workflows и compatible rollback. Разрешены только export/platform/output/source-map/clear arguments; private-key/signing/server arguments отвергаются.
2. Перед Expo принудительно устанавливается `EXPO_NO_DOTENV=1`. Signing config, dynamic Expo config, известные signing/cloud credentials и Node preload приводят к отказу. Значения секретов в evidence не сохраняются.
3. Команды start/android/ios/web по умолчанию используют **localhost**. Это ограничивает обычный dev-server запуск; работа через LAN/внешний DevTools требует отдельной оценки и не становится разрешённой из-за зелёного gate.
4. Workflows используют hosted isolated runners, `contents: read`, pinned action SHAs, checkout без persisted credentials. Secret references, расширение job permissions и signing/deploy команды запрещены условиями профиля.
5. Policy фиксирует точные версии/пути семи reviewed packages, полный lock graph, audit graph, manifest/lock byte hashes и набор контрольных файлов. Нормализация control files — только CRLF → LF; отсутствие возможных config-файлов также фиксируется.
6. Проверяются все три source maps, соответствующие bundles и per-build `security-export.json`. Старое export evidence с другим lockfile, исходниками, конфигурацией либо изменёнными bytes отвергается.
7. Raw full audit сохраняется с настоящим exit code. Новая advisory любого уровня, scope/severity/version drift, ошибка audit/advisory/registry, нарушение условий или expiry дают FAIL.
8. Проверяются metadata текущих root packages и совместимых Expo 57 releases. Даже Zod 3 backport, не меняющий npm latest major 4, вызывает обязательную переоценку. Известное исправление Zod 4.6.6 за пределами диапазона CLI явно учтено в текущем принятии риска.

В актуальных source maps отсутствуют `node-forge`, `zod`, `braces`, `fast-uri`, `serialize-javascript`. Это подтверждает ограниченную экспозицию клиентских bundles, но не является доказательством безопасности всего tooling. В app.json нет code-signing config; export не запускает DevTools server. Недоверенные certificate/plugin inputs не подавались. Эксплуатация уязвимостей не выполнялась.

## Фиксированная конфигурация исключения

Исполняемая конфигурация: `scripts/security-policy.json`, профиль `expo57-unsigned-tooling-20261025`.

- Только `GHSA-86w9-cpqp-85rv` и `GHSA-mrhx-c7xc-m3w5`, оба HIGH.
- Начало: **2026-10-25T10:32:09.000Z**.
- Окончание: **2026-11-08T10:32:09.000Z**; строгое сравнение `now < expiresAt`.
- `package-lock.json` SHA-256: `11dea78e22dc9fca39b5df454a2b580c4a983fbe160bdee4f4044742df006808`.
- `package.json` SHA-256: `50a22385d9f0808baf27102019c5baae2b28530353387f3c43f4da5d8ba177a8`.
- Audit graph SHA-256: `090c1d76aa282ff1eb710412aa74f1b5a2c93d3d0cfb97bd1531d6b0340c18ed` (`arborist-derived-metadata-v2`).
- Lock graph SHA-256: `48d0673c48cc6584fa7a07e24dad8329ceb07a80b58bb40cbcedc8436d6cb885`.
- Control manifest SHA-256: `f2f57ff988d3212e5c3b4610244eaa935c4605bb08eba2a4d41ce9b1172eb384`.
- Policy SHA-256: `e07122de4ababd6057457ea3b55c522da484a0b9688ce07c245dcb6cf1e8d8b7`.

Все hashes вычислены из проверенных файлов существующими/новыми проверочными функциями, а не подставлены для обхода проверок. SQL release manifest остаётся прежним, SHA-256 `734f8a88143c924ae0f8f4e4e66e43c4bff9af4633576d4c7a9b86b5d1ddc4c9`; его generator/check прошёл. Его назначение — миграции/schema, зависимость от нового package graph отражена отдельно в security/export provenance. SQL-файлы не менялись.

Повторные CI/audit/npm ci/build не записывают policy и не вычисляют новую дату окончания. Число 14 суток проверяется gate. Продление требует нового явного решения владельца и повторной оценки. В репозиторий не добавлен автоматический renew script; одноразовый helper активации находится только в ignored evidence и отказывается заменять уже активированное окно.

## Регрессионная проверка

| Проверка | Новый результат этого этапа |
| --- | --- |
| `npm ci` в основном checkout | exit 0, реальные версии обновлены |
| Отдельный чистый `npm ci` | exit 0; lock/manifest и установленные reviewed versions совпали |
| `npm ls --all` в обоих окружениях | exit 0 |
| `npm explain` четырёх root/обновлённых пакетов | exit 0, все dependency paths сохранены |
| Full npm audit в обоих окружениях и при активации/gate | exit 1; только 5 HIGH / 2 согласованных roots |
| Реальный security gate и CLI | **PASS WITH APPROVED EXCEPTION**, CLI exit 0, raw exit 1 |
| Unit Node 22.20.0 | **992/992 PASS**, runner exit 0 |
| Unit Node 24.15.0 | **992/992 PASS**, runner exit 0 |
| Security/release focused | **126 PASS: 49 legacy gate + 61 новых + 16 release tools** |
| TypeScript | PASS |
| ESLint без cache | PASS |
| Expo Doctor 1.21.5 | **21/21 PASS** |
| Production-mode Web export | PASS, с фиктивной public config и без публикации |
| Combined Web/Android/iOS exports и compatible rollback export | PASS, source maps и provenance проверены |
| Workbox generation | PASS, **6 precache entries**; presence и content revisions сверены |
| PWA Chromium/WebKit | PASS в обоих движках |
| Storage Chromium/WebKit | PASS: старый SW/v5, v6 compatibility, blocked upgrade recovery, настоящий process restart |
| Workflow validation и actionlint 1.7.12 | PASS, оба workflows |
| SQL release manifest/hash check | PASS; миграции не применялись |
| `git diff --check` | PASS |

Прежние **931** тест сохранены; добавлен **61** тест. Старые 49 gate cases проверяют зафиксированный legacy fixture и не позволяют старому согласию автоматически перейти на новый граф. Assertions не отключались: изменены ссылки на snapshot и ожидаемые усиленные full-audit/guarded-export/pinned-action команды. Новые cases покрывают все требуемые состояния, unknown HIGH/MODERATE/LOW/CRITICAL/INFO, lock/graph/version/path drift, повреждённые данные, advisory errors, scope substitution, нарушенные условия, stale exports и expiry с управляемыми часами.

PWA проверяет действующий сгенерированный Workbox: offline shell, connection failure, 502/503 fallback, сохранение 401/403/404, зависшие headers/body, ожидание обновления SW и ровно один reload по действию пользователя. В полном result `updateReloads=2` включает следующий явный reload проверки отсутствующего offline shell; проверка применения обновления отдельно требует ровно один. Время восстановления — около 5.0–5.4 s; browser page errors отсутствуют.

Отдельная storage проверка действительно закрывает и заново запускает browser process с собственным persistent profile, затем сравнивает IndexedDB **v5**, cache, непустые v2/v3 outbox rows и полный handle. Проверяются оба движка. Эти сценарии используют синтетические данные; они не являются приёмкой физических Android/iOS, signed native binary или OTA. Бизнес-код, cache/sync/RLS и F01–F05 не менялись.

Первоначальные неуспешные попытки сохранены в `attempts/`: устаревшая literal CI assertion, ошибочное обнаружение evidence-копии `*.test.mjs` как теста и некорректные данные нового restart fixture. Исправлены тестовое ожидание/имя копии/fixture; продуктовые защиты не ослаблялись. Итоговый PASS подтверждён **exit 0**, а не только числом успешных assertions.

## CI, release acceptance и artifacts

Оба workflows продолжают выполнять обязательные проверки. Release security job публикует отдельные status/npmAudit/policySha256/lockSha256 outputs. Его gate сохраняет raw audit даже при предыдущем сбое build, если npm ci завершился успешно; такой job всё равно не становится зелёным из-за failed checks.

`release-acceptance-decision` требует success static/database/security, принимает только настоящий clean PASS либо PASS WITH APPROVED EXCEPTION, связывает output с точным policy/lock и повторно проверяет expiry перед созданием receipt. Истёкший за время остальных jobs exception не принимается. Проверки tested SHA и migration manifest сохранены. Реальный CLI output дополнительно проверен существующей новой decision function без создания общего release receipt.

GitHub Actions удалённо не запускались: commit/push запрещены. Это локальная валидация workflow и его decision logic. F07, `vercel.json`, hosting build hold и удалённые Vercel/Timeweb settings не изменялись. Перед фактическим выпуском нужен новый полный gate в пределах окна и отдельное разрешение на release; старый artifact сам по себе не продлевает исключение.

Совместимый rollback artifact пересобран существующим builder в `.expo/compatible-rollback`, с новым `security-export.json`, hashes всех **103** файлов и source snapshot. Он сохраняет v3 namespace/handles, web storage v5/native storage v6. Финальный manifest пересоздаётся после документации, чтобы source hash соответствовал окончательному дереву. CI public config `ci.invalid` оставляет artifact **localVerificationOnly**; публикация не выполнялась.

## Изменённые файлы и сохранность прежней работы

В этой фазе изменён/добавлен **21** путь:

- `package.json`, `package-lock.json`.
- `scripts/security-policy.json`, `scripts/security-policy-gate.mjs`.
- `scripts/security-tooling-conditions.mjs`, `scripts/security-export.mjs` — новые guard/export helpers.
- `scripts/build-compatible-rollback.mjs`, `scripts/check-release-workflows.mjs`, `scripts/release-decision.mjs`.
- `scripts/pwa-mobile-browser-smoke.mjs`, `scripts/release-storage-browser.mjs` — evidence isolation и дополнительный restart scenario.
- `.github/workflows/ci.yml`, `.github/workflows/release-acceptance.yml`.
- `tests/security-policy-gate.test.mjs`, `tests/ci-coverage.test.mjs`, новый `tests/security-exception.test.mjs`.
- Новые `tests/fixtures/security-exception-audit.json`, `tests/fixtures/security-policy-legacy-policy.json`.
- `docs/release/security-proposal.md`, `docs/release/security-proposal.json`, F06-раздел `docs/release/runbook.md`.

Общий Git status с прежними изменениями: **61 modified, 56 untracked, 0 staged**. HEAD остаётся `810f1a367b7d350b5e3ce1bb0b62f22093ba9049`; index не изменён. Все прочие начальные файлы сохранены, включая source business logic, F01–F05, F07 и все **84** SQL-миграции. Основной отчёт прежнего этапа остаётся историческим evidence.

Полный статус, hashes, исходные audit/registry/advisory ответы, команды/exit codes, результаты тестов и предыдущие artifacts находятся в **`C:\Users\chupa\proj\TeamTrack\.expo\f06-activation-2026-10-25\`**. Ключевые файлы: `baseline.json`, `activation.json`, `activation-result.json`, `activation-audit.json`, `activated-gate/`, `github-output.txt`, `cli-release-classification.json`, `unit22.json`, `unit24.json`, `security-unit.json`, `precache-validation.json`, `pwa/`, `final-state.json`, `git-status.txt`. Финальные artifact hashes и сверка scope записываются в ignored `final-state.json`, чтобы избежать self-referential manifest hashes в tracked документах.

**Commit/push/deploy не выполнялись. Production Supabase, локальная Supabase-схема и удалённые hosting settings не изменялись. Supabase-миграции не применялись. Production release остаётся HOLD.**
