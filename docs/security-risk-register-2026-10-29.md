# TaskTrace security gate и постоянный реестр рисков

Независимо проверено 29.10.2026 перед доставкой. Этот документ фиксирует локальные результаты и действующие правила gate. Production, hosted Supabase, пользовательские данные и публикация не затрагивались. Результаты CI должны отдельно подтверждаться для SHA доставки.

## Результат

- Security policy gate: **PASS WITH ACCEPTED RISKS**.
- Полный `npm audit`: **FAIL**, исходный JSON сохранён без фильтрации. В отчёте 10 уязвимых package entries: 3 HIGH и 7 LOW; два корневых advisory рассмотрены ниже.
- Локальные Web/Android/iOS unsigned exports и source-map gate: **PASS**.
- Release acceptance: **18/18 PASS** в повторном полном прогоне. Первый прогон и его отказ сохранены отдельно. Chromium и WebKit прошли по 173 responsive-измерения, включая exact dark 320 px / CSS zoom 200%, effective viewport matrix, внутреннюю ширину кнопок и кликабельность навигации.
- `npm test`: **91 файл / 1109 тестов PASS**; TypeScript, ESLint и connection policy PASS. Expo Doctor: 21/21; PWA/SW на Chromium и WebKit PASS.

## Первопричины прежней хрупкости

Старая схема смешивала реальные защитные условия с контрольной суммой прежнего состояния репозитория. Security policy фиксировала полные хеши build/control-файлов, manifest и lockfile, fingerprint dependency graph и точный audit graph. Изменение безопасной реализации, обычной зависимости или состава метаданных давало FAIL даже тогда, когда текущие меры сохранялись.

Кроме этого, временный профиль включал `startsAt`, `expiresAt`, продолжительность 14 дней и проверки даты как в security gate, так и в release decision. Это превращало уже оценённый риск в календарный блокер и требовало ручного продления.

## Новая модель

`scripts/security-policy.json` содержит постоянные точечные записи advisory. Кодовый каталог в `scripts/security-policy-gate.mjs` отдельно ограничивает допустимые ID, пакет, диапазон, severity, корни зависимости и необходимые меры. Добавление нового риска требует явного изменения и данных, и проверяемой оценки; wildcard и автоматическое принятие по уровню severity запрещены.

На каждом запуске gate проверяет полный `npm audit --json` с явным include всех групп, audit-level=info и отключённым workspace-фильтром; сохраняет исходный stdout/stderr. Настройки npm omit/audit-level не могут сузить проверку. Структура, exit code, счётчики и все записи должны быть целостны. Текущие manifest и lockfile должны совпадать по корневым зависимостям. Дополнительная проверка сопоставляет зарегистрированные affected ranges с текущими lock nodes: ложный clean audit не скроет известную уязвимую версию. Для активного advisory gate проверяет GHSA/npm metadata, установленную версию, цепочки `via/effects`, lock nodes, фактические root dependency paths, наличие совместимого fixed version и отсутствие пакета в свежих клиентских source maps.

Компенсирующие меры проверяются по текущему поведению и структуре:

- Expo export идёт только через ограниченный unsigned wrapper; signing, динамический Expo config и известные привилегированные credentials отклоняются.
- `EXPO_NO_DOTENV=1`; Node preload/loader запрещён; Expo dev server закреплён на localhost.
- GitHub Actions требуют `contents: read`, exact commit pins, отсутствие secrets и write permissions, отключённые checkout credentials и отсутствие шагов deployment/hosted migrations.
- CI и release acceptance сохраняют обязательные static/database/security jobs; release decision связывает security outputs с текущими policy, lockfile и manifest.
- Web/Android/iOS source maps, включая sourceRoot, проверяются на отсутствие инструментальных риск-пакетов. `security-export.json` связывает export с текущими исходниками, build environment и хешами bundle/map файлов; конкурентная правка во время сборки отклоняется.
- Реальные nested/peer dependency paths и установленные версии проверяются независимо от audit. Пять установленных исходников на рассмотренных Expo/config/Workbox call paths требуют пересмотра при изменении; это не хеши всего lock graph или прикладных helper-файлов.

Artifact hashes подтверждают текущую сборку; они не сверяются с прежним выпуском. Изменённый исходник/build helper требует свежего экспорта для соответствия checkout, но не ручного обновления policy.

## Реестр advisory

| Advisory | Текущая версия и путь | Статус | Решение и пересмотр |
|---|---|---|---|
| `GHSA-86w9-cpqp-85rv` — node-forge, HIGH, `<=1.4.0` | Установлено `1.4.2`; через `@expo/code-signing-certificates` → Expo CLI/Expo | `remediated` | Совместимый upstream fix доступен начиная с `1.4.1`; `1.4.2` удовлетворяет диапазону потребителя `^1.3.3`, advisory отсутствует в текущем audit. Обновление lockfile внесено. [Upstream release](https://github.com/digitalbazaar/forge/releases/tag/v1.4.1), [advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Если advisory вернётся или пакет попадёт в bundle/новый root, gate завершится FAIL. |
| `GHSA-mrhx-c7xc-m3w5` — zod, HIGH, `<4.6.6` | Установлено `3.25.76`; через `eslint-config-expo` и `expo`/`@expo/cli` | `accepted` | Исправление начинается с `4.6.6`, но текущие потребители Expo CLI 57 требуют Zod 3; `4.6.6` не удовлетворяет их диапазонам. Пакет остаётся инструментальной зависимостью и отсутствует во всех трёх bundle maps. Пересмотр обязателен при совместимом исправлении, изменении severity/range, новых root paths, появлении в bundle или потере меры. [GitHub advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). |
| `GHSA-gcqx-w48m-w2h4` — deepmerge, LOW, `>=4.2.0 <=4.3.1` | Установлено `4.3.1`; через `@expo/config` → Expo и `@rollup/plugin-node-resolve` → `workbox-build` | `accepted` | Advisory считается реальной: upstream repro требует attacker-controlled JSON и target с `null`-placeholder; он изменяет prototype возвращённого объекта. В установленной цепочке Expo уязвимый merge helper вызывается конфигурационными mutation operations, не allowlisted `expo export`; Workbox resolver вызывает `deepmerge({}, defaults)` с собственными константными defaults, без attacker-controlled JSON и null-placeholder target. CI экспорт принимает только статическую конфигурацию, работает read-only без секретов/подписи, source maps должны исключать пакет. В upstream registry нет fixed release. Пересмотр обязателен при исправленной совместимой версии, изменении call path/границы входов, новом root, bundle exposure или потере меры. [GitHub advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), [upstream issue и repro](https://github.com/TehShrike/deepmerge/issues/273). |

Трассировка call path и отсутствие уязвимых пакетов в bundle — вывод из текущего lockfile, установленного package source и свежих локальных source maps. Это не утверждение, что `deepmerge` безопасен в общем случае или что любой его call site защищён.

## Поведение при изменениях

Gate может пропустить UI/business/offline/test/helper изменения и обновления безопасных зависимостей, если текущие проверки сохраняют прежние root paths и ограничения. Совместимое исправление уязвимости проходит при чистом полном audit. Для изменённого кода перед запуском gate всё равно нужны актуальные export artifacts.

Gate возвращает FAIL при новом/неизвестном advisory любого уровня, изменившемся GHSA scope/severity, расширившейся достижимости, совместимом доступном fix при всё ещё уязвимом lock, несогласованном audit, повреждённом lock, неизвестном CI action/permission, signing/credential/preload конфигурации, недостающих или устаревших bundles, нарушении provenance либо отсутствующем обязательном release job.

В активных policy/gate/release decision нет `expiresAt`, срока 14 дней, renewal или временного профиля. Дата 8 ноября 2026 года не участвует в решении. Условия пересмотра содержатся в строках `reviewTriggers`, а не в календаре.

## Проверки

- `npm test` — **91/91 files, 1109/1109 tests PASS**; включает connection policy, typecheck, lint и полный Vitest. Независимая collection baseline: 1145 − 62 obsolete exception − 49 old gate + 56 new gate + 19 уже закоммиченных refresh tests = 1109.
- `tests/security-policy-gate.test.mjs` — **56/56 PASS**; покрывает неизменность решения при переходе даты, ложный clean audit, исправление уязвимости, безопасное изменение lock graph, новые advisory/severity/root paths, malformed audit/lock, installed package validation, unsigned/workflow controls, artifact integrity, release decision и end-to-end gate.
- `node scripts/security-tooling-conditions.mjs` — PASS.
- `node scripts/check-release-workflows.mjs` — PASS.
- `node scripts/security-export.mjs --platform web --platform android --platform ios --source-maps --output-dir .expo/security-export` — PASS; собраны все три платформы.
- `node scripts/security-policy-gate.mjs --bundles .expo/security-export` — PASS WITH ACCEPTED RISKS; raw npm audit остаётся FAIL (3 HIGH / 7 LOW / 10 total).
- `node scripts/release-bundle-exposure.mjs .expo/security-export` — PASS; node-forge, zod и braces отсутствуют. Gate отдельно проверил deepmerge.
- `node scripts/run-release-acceptance.mjs` — **18/18 PASS**. Временная тестовая БД и принадлежащий запуску PostgreSQL container удалены; production не затрагивался.
- Backend/Auth/PKCE/Realtime/CAS/RLS и браузерные регрессии PASS. Actual local Deno `client-errors`: Chromium/WebKit, восстановление snapshot, сохранённый blocked outbox, доставка при Data API 503, privacy и quota race PASS; 24 тестовые записи.

## Файлы и область доставки

Реализация: `scripts/security-policy-gate.mjs`, `scripts/security-policy.json`, `scripts/security-tooling-conditions.mjs`, `scripts/release-decision.mjs`, `scripts/check-release-workflows.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release-acceptance.yml`, `package-lock.json`.

Тесты: `tests/security-policy-gate.test.mjs`, `tests/fixtures/security-risk-audit.json`; удалены obsolete временные-policy tests и fixtures. Исторические документы помечены superseded, а клиентская диагностика и release runbook обновлены.

На момент этой локальной записи реальные CI receipts нового commit ещё должны быть получены. Production release остаётся на HOLD до прохождения независимых условий runbook. UI acceptance исправлен; hosted migrations, Edge/frontend publication не выполнялись. Подробное независимое ревью и план rollout: [independent-release-review-2026-10-29.md](independent-release-review-2026-10-29.md).
