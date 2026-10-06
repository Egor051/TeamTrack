# Offline lifecycle audit and state model

Audit of the checkout on 4 October 2026, before implementation:

- `connectivity/state.ts` owned an optimistic online flag, its own probe and browser listeners. Offline cold start relied on an online event; foreground/pageshow did not repair missed events. A successful unrelated response could open the network path before the Auth + Data API probe finished.
- `AuthProvider` restored local identity, independently reapplied session after connectivity, and async session reads could arrive after a newer auth event. Token refresh remounted both offline providers.
- `OfflineBootstrapProvider` and `SyncProvider` independently scheduled startup, reconnect, foreground and realtime work. They shared a Web Lock but not a recovery lifecycle. Sync requested reruns for every duplicate trigger.
- `bootstrap.ts` persisted `running`/`updating`, dataset `loading`, progress and lease alongside verified data. Metadata reads restored these as an active operation without a live worker. Its CAS/lease and per-request abort guards were useful, but did not establish a single runtime lifecycle.
- Readiness reads trusted stored booleans. Basic and Extended needed local verification of batches, committed UI models and assets. Optional dataset failures incorrectly contributed complete units to progress, and terminal basic success could report 100% for incomplete Extended preparation.
- `sync.ts` bounded network requests, but not the complete pass, storage waits or queued Web Locks; stale same-account work could update runtime state after cleanup. Meaningful pull on focus advertised user synchronization despite no pending edits.
- `status.ts`, bootstrap hook state and connectivity independently projected overlapping facts. The UI combined durable metadata, runtime flags and realtime connection status.

The implementation keeps transport-only cache fallback, account namespaces, mutation receipts, conflict handling, stable server snapshots and cross-tab CAS. Runtime operations belong to `runtime-state.ts`; persistence contains stable completeness facts and coordination leases, never proof that a worker is alive. Preparation, recovery, user synchronization and background refresh have independent identities and terminal outcomes. The coordinator serializes recovery, and UI uses projections of runtime operations plus verified storage facts. A timeout is an error/cancellation outcome, never a readiness shortcut.

## Реализованная модель

`src/lib/local-cache/runtime-state.ts` — единственный владелец изменяемого runtime-состояния offline subsystem. Рабочие процессы публикуют transitions и факты; `status.ts`, `getBootstrapMetadata()` и UI hooks служат адаптерами чтения. В runtime snapshot нет второго поля `preparing`, `syncing` или `progress`, которое могло бы расходиться с operation records. Ошибка первой storage-записи также принадлежит operation record; отдельный snapshot `storageFailures` удалён. Автоматический backoff работает даже когда storage не может сохранить retry metadata.

| Факт | Источник и смысл |
| --- | --- |
| Физическая сеть | `physical: unknown / connected / disconnected`; browser events или native NetInfo |
| Доступность backend | `backend: unknown / reachable / unavailable`; bounded Auth + Data API probe и проверенные ответы |
| Локальные данные | Записи конкретного `user_id`, независимо от наличия сети |
| Completeness | Проверенные Basic/Extended certificates, batches, read models и PWA assets |
| Pending mutations | Durable outbox; pending, failed, conflict и unreconciled учитываются отдельно |
| Активность | Operation records в слотах `pipeline`, `preparation`, `sync` |
| Тип работы | `recovery`, `preparation`, `synchronization`, `refresh` |
| Ошибки | Terminal outcome операции, проверенные storage/backend errors и durable retry metadata |

Каждая операция получает `id`, account `epoch`, `AbortController`, deadline и terminal outcome. Переход допускается только от текущей операции:

```text
running → success / partial / waiting-network / error / cancelled / superseded
```

Terminal transition очищает live progress и видимость. Запоздалый callback старой операции не меняет новую. Account switch и dispose инвалидируют epoch; refresh токена того же пользователя не пересоздаёт coordinator.

Дедлайны: отдельный шаг storage/RPC — 20 секунд, backend probe — до 45 секунд, sync pass — 5 минут, preparation — 10 минут, recovery pipeline — 15 минут. IndexedDB transactions дополнительно ограничены 10 секундами. Watchdog завершает операцию ошибкой и отменяет её работу; он не выставляет `ready`. Scoped storage driver отклоняет отменённую запись; SQLite проверяет signal внутри exclusive transaction перед commit, IndexedDB aborts transaction. CAS и server receipt/version checks продолжают защищать cross-tab replay.

## Recovery, Retry и browser events

Один `OfflineRuntimeProvider` заменяет независимые preload/sync providers. `coordinator.ts` сериализует startup, reconnect, Retry, изменение схемы, freshness, realtime invalidation и новые mutations.

С 7 октября 2026 coordinator владеет одним timeout: foreground safety tick каждые 20 секунд после завершения предыдущего прохода, либо более ранний срок события/retry. Отдельного interval в provider нет; retries sync worker передают свой deadline через `sync-retry` этому же scheduler. Скрытая вкладка пропускает периодические проверки. Новая mutation прерывает ожидание recovery, но сохраняет собственный sync backoff; изменения, пришедшие во время работы, учитываются счётчиками demand и получают следующий проход без параллельных workers.

Полный проверенный cache на обычном tick требует только локального чтения metadata/очереди: без backend probe, session refresh, RPC и изменения видимых статусов. Возраст snapshot сам по себе не запускает preload. После долгого foreground return (5 минут без sync check) выполняется один pull check; повторные focus events его не дублируют. Preparation нужна при неполной выбранной Basic/Extended readiness, retry, смене дня или реальном invalidation. Перед догрузкой bootstrap проверяет каждую сохранённую страницу; отсутствующая/повреждённая страница не заставляет скачивать остальные страницы dataset.

Recovery сохраняет durable coalesce 30 секунд и jittered backoff от 30 секунд до 5 минут; optional failures ждут 5 минут. Когда retry metadata нельзя записать или lease занят, coordinator использует backoff 5, 10, 20 секунд и далее до 5 минут. Foreground/tick не сбрасывают эти сроки. «Обновить» присоединяется к live pipeline, перепроверяет её результат и может явно повторить нужную работу; исправный полный cache повторно не скачивается. На `/projects` два статуса расположены в общем блоке 288×40 px слева от кнопок; на узком экране блок занимает строку над кнопками, подробности ошибок раскрываются явно.

Recovery проверяет backend и session, выполняет существующий sync push/pull/reconcile, затем продолжает/перезапускает preparation и читает проверенные локальные факты. Sync engine сохраняет предварительный pull для обнаружения конфликта до push. Bootstrap lease/coalesce/backoff ограничивает только preparation; он не откладывает проверку runtime permissions и replay очереди.

Повторные reconnect events присоединяются к текущей pipeline. Реальное изменение данных/очереди может запланировать один следующий проход. Focus, visible `visibilitychange`, `pageshow` и AppState active запускают freshness check; pull без pending edits остаётся `refresh` и не показывает «Синхронизация: в процессе». `blur` и скрытая вкладка не запускают работу. Connectivity monitor также сверяет физическую сеть при foreground, исправляя пропущенный `online` после offline cold start.

`navigator.onLine === true` разрешает попытку запроса, но UI backend state остаётся unknown до фактического ответа. В degraded режиме используется локальное чтение; восстановление открывает сетевой путь после общего probe. Поздний успешный запрос не стирает более новую transport failure и не обходит выполняющийся probe.

Retry инвалидирует pipeline и старые workers, отменяет их запросы/записи, дожидается ограниченного cleanup старого bootstrap, сбрасывает собственный retry gate, запускает новый probe и новую pipeline. Живой lease другого tab сохраняется; после его освобождения/expiry coordinator повторяет попытку. Offline recovery завершается `waiting-network`, сохраняя доступные данные, и возобновляется при подтверждённом reconnect. Ошибки имеют автоматический backoff; неполный Extended повторяется и при недавно успешном Basic.

## Readiness и persistence

Basic требует все 12 mandatory datasets: профиль, проекты с архивом, members/profiles, tasks с архивом, roles/overrides/assignees, items, templates/template items и daily audit за текущий день UTC+3. Проверяются schema/user identity, manifest, полный row count каждого batch, checksum сертифицированного batch и наличие соответствующих committed UI read models. Проверяется собственный профиль, identities, типы и полнота моделей; более новые подтверждённые item versions не откатываются. Для web readiness также необходимы активный service worker и сохранённые shell/manifest/icons/favicon/app scripts.

Extended дополнительно требует полный 90-дневный history, notifications и last editors по тому же manifest/snapshot contract, включая их committed read models. Basic certificate публикуется независимо, до optional datasets. Отсутствующий/повреждённый Extended model оставляет Basic доступным, но не даёт Extended `ready`. Готовый cache при потере сети остаётся готовым. Смена дня делает daily readiness устаревшей, а сохранённые данные остаются читаемыми.

Certificates создаются после проверки server manifest и атомарного commit моделей; checksums служат обнаружению повреждения local batch, не границей авторизации. Повреждённый batch того же размера заново скачивается, а не повторно сертифицируется. Старые проверенные batches сохраняются до готовности нового snapshot.

Persist содержит cache, manifest/version, certificates/completeness, выбранную схему, timestamps, очередь, конфликты, last successful sync и retry/lease metadata. Lease — ограниченный механизм координации между tabs, не доказательство живого worker. `running`/`updating` и dataset `loading` сериализуются в стабильные `ready`/`partial` и `pending`; `started_at` очищается. `ready`/100% сохраняется только для готовой выбранной схемы: выбор неполного Extended offline сохраняет `partial` при доступном Basic. Legacy runtime статусы нормализуются при чтении, включая day rollover. `syncing`/`recovering` не сохраняются. Persisted progress остаётся metadata и никогда не восстанавливает lifecycle.

Финальная verification — отдельная единица progress. Недоступный optional dataset не считается выполненным. 94% после прерывания может быть metadata стабильного `partial`; он не удерживает operation в `running` и не подменяется искусственным 100%.

## Изменённые файлы

| Группа | Файлы |
| --- | --- |
| Новый runtime и scheduler | `src/lib/local-cache/runtime-state.ts`, `coordinator.ts`, `work-requests.ts` |
| Providers и Auth | `src/app/_layout.tsx`, `src/features/auth/AuthProvider.tsx`, `src/lib/local-cache/OfflineBootstrapProvider.tsx`; удалён `SyncProvider.tsx` |
| Connectivity | `src/lib/connectivity/state.ts`, `fetch.ts`; `src/lib/local-cache/cache.ts` |
| Preparation/readiness | `src/lib/local-cache/bootstrap.ts`, `bootstrap-types.ts`, `use-offline-bootstrap.ts` |
| Sync/storage | `src/lib/local-cache/sync.ts`, `status.ts`, `edit.ts`, `conflicts.ts`, `types.ts`, `driver.web.ts`, `driver.native.ts` |
| UI projections | `src/components/ui/offline-ready-indicator.tsx`, `realtime-indicator.tsx` |
| Browser regressions | `scripts/account-offline-browser-smoke.mjs`, `scripts/phase6-browser-smoke.mjs` |
| Tests | Новый `tests/offline-runtime-lifecycle.test.ts`; обновлены `offline-auth-startup.test.tsx`, `offline-bootstrap-provider.test.tsx`, `offline-bootstrap.test.ts`, `offline-connectivity.test.ts`, `offline-native-storage.test.ts`, `offline-phase6-runtime.test.ts`, `offline-sync.test.ts`, `offline-web-storage.test.ts`, `sync-status.test.ts`, `sync-ux.test.tsx` |
| Отчёт | `docs/offline-state-architecture.md` |

## Регрессионное покрытие

| Сценарий | Проверка |
| --- | --- |
| Online startup → ready, порядок pipeline | Coordinator tests и production browser |
| Preload → progress → ready | Реальный IndexedDB bootstrap tests и browser Basic/Extended |
| Network loss во время preparation, 94% → reconnect → ready | Coordinator + bootstrap deadlines; browser удерживает Extended final manifest на 94%, прерывает сеть, проверяет resume и поздний ответ |
| Cold offline startup → local UI → reconnect без reload | Auth/bootstrap/coordinator tests, несколько browser циклов |
| Navigator online + backend unavailable | Connectivity tests и degraded navigation smoke |
| Error → Retry → success | Bootstrap/coordinator; browser заменяет hung manifest, поздний ответ игнорируется |
| A → B → B finishes → late A | Runtime ticket tests, реальный bootstrap Retry, aborted web/native storage writes, поздние Auth success/error |
| Visibility/focus/reconnect bursts | 50/100 events в unit tests, повторные browser events без ложного user sync |
| Reload во время preparation | Legacy durable metadata + отсутствие live operation, также day rollover |
| Basic/Extended фактическая полнота | Missing/malformed models, same-length batch corruption, history/notifications, assets, optional failure |
| Account isolation, outbox, receipts, conflicts | Существующие cache/storage/sync/RLS/HTTP suites и runtime epoch tests |
| Preparation backoff не блокирует sync permission check | Отдельный coordinator regression и Phase 6 kill-switch smoke |
| Отмена первого storage commit и отказ quota без durable retry | Поздняя ошибка не меняет успешную новую попытку; coordinator ограничивает частоту автоматических попыток |

## Проверки 4 октября 2026

Проверки выполняются против локального Supabase и production static web export. Build flags включаются только в environment smoke процесса; production flags и `.env` не изменяются.

| Команда | Результат |
| --- | --- |
| `npm test` | PASS: DB URL policy, typecheck, lint, 35 test files / 355 tests |
| `npm run typecheck` и `npm run lint` отдельно | PASS перед публикацией, дополнительно к `npm test` |
| `npm run test:sql` | PASS: 11 SQL suites на локальном Postgres, включая RLS/RPC, receipts, conflicts, retention и bootstrap |
| `npm run test:backend` | PASS: Data API/Auth/Realtime, web/native PKCE, two-session concurrency, стабильные bootstrap pages и PT409 recovery |
| `npm run smoke:offline:browser` | PASS полного повторного прогона: automatic Basic, offline direct reload, 3 reconnect без reload, hung Retry/late reply, focus без false sync, durable writes/3 receipts, cross-tab disable, Extended 94% interruption/reconnect, 90-day history и 220 notifications |
| `npm run smoke:offline:performance` | PASS финального повторного прогона: cached offline routes 61–191 мс, 0 HTTP requests; degraded follow-up routes 26–32 мс. Измерения: `.expo/offline-navigation-after.json` |
| `npm run smoke:phase6:browser` | PASS: compact indicator, online/offline edits, F5/reconnect, conflicts, runtime kill switch, multi-tab receipt, service-worker update с pending operation, failed-operation Retry |
| `npx expo export --platform all --clear --output-dir .expo/offline-all-export-20261004` | PASS на финальном коде: Android, iOS, web; 35 static routes. Отдельный output сохранял production browser smoke во время export |
| `npm run build:web` | PASS с обычным production environment: 35 static routes, service worker/6 precached files; write/sync build flags OFF |
| `npx --yes supabase@2.116.0 db advisors --local --type security --level warn --fail-on error` | PASS: No issues found |
| `git diff --check` | PASS; новые файлы дополнительно проверены на whitespace |

Первый Phase 6 прогон выявил задержку sync permissions из-за bootstrap backoff; исправлено и добавлен regression. Следующий запуск остановился на обращении `npx` к registry во время fixture setup. Cached CLI с process-local `npm_config_offline=true` устранил внешнее ожидание; приложение не изменялось ради этой инфраструктурной проблемы.

Полные browser suites проверяют recovery, очередь, конфликты и Basic/Extended flow. Перед публикацией на финальном коде повторно прошли `npm test`, отдельные typecheck/lint, SQL/backend suites, полный `smoke:offline:browser` и all-platform export. Последние узкие правки для ошибки первой storage-записи и сериализации выбранной схемы покрыты отдельными regressions и этим полным browser прогоном. Это не заменяет реальные device/hosted проверки.

## Ограничения

Реальные Android/iOS устройства и standalone установленная PWA не проверялись; native export и mocked SQLite regressions не являются device acceptance. Hosted Supabase/production account не менялись и не проверялись этим прогоном. Актуальная server authorization по-прежнему обеспечивается RLS/RPC; сохранённая session идентифицирует cache namespace и не доказывает текущий доступ.

Если backend постоянно отказывает, optional contract отсутствует, storage недоступно или доступ отозван, корректный stable outcome — `partial`, `waiting-network` либо `error`, с повтором/возможностью действия пользователя. Готовность не объявляется без данных. После возврата необходимых внешних условий pipeline восстанавливается автоматически. Браузер может приостановить таймеры скрытой страницы; foreground выполняет повторную сверку сети и freshness.

Миграции, hosted configuration, зависимости и production flags не изменены. На этапе реализации commit/push не выполнялись; публикация проводится отдельным проверенным шагом по запросу пользователя.
