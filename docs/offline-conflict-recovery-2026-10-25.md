# Исправления N01/N02: разрешение офлайн-конфликтов

Исправления относятся к клиентскому lifecycle, транзакциям существующих драйверов и их проверкам. Серверный v3 протокол, миграции, policy и security exception сохраняют свой контракт.

## Состояния attempt

| Состояние | Повтор `chooseMine` | Замена ID |
|---|---|---|
| Подтверждённый `conflict` с v3 handle | Явный rebase по подтверждённой CAS версии | Новый UUIDv8; зависимости и conflict references меняются атомарно |
| `pending` с handle, включая потерянный ответ или ошибку local ACK | Replay прежних generation, epoch, UUID и expected_version | Запрещена |
| `synced_unreconciled` | Продолжение reconciliation без повторной мутации | Запрещена |
| `review` | Предусмотренная сверка результата и текущего состояния | Запрещена; автоматической отправки нет |
| Никогда не отправленный dependent draft | Ожидание ACK предшественника | Существующий ID сохраняется |
| Исторический v1 | Review без преобразования в v2/v3 | Исторический ID сохраняется |

`chooseMine` проходит через существующую recovery queue и `tasktrace-sync:<userId>` Web Lock. Конфликт и outbox читаются после получения lock и проверки account/runtime epoch. Второе действие из той же или другой вкладки повторно читает durable состояние; уже завершённый конфликт не начинает новую операцию.

`rebaseAttempts` повторно проверяет статусы внутри транзакции драйвера. Старый conflict record сам по себе не разрешает заменить pending handle: отсутствие ACK не означает отсутствие server commit. При ошибке local ACK исходный pending handle остаётся доступным для replay. При ошибке reconciliation сохраняется ACKed состояние.

## Terminal review

`push` прекращает conflict replay после первого terminal outcome. Обычная очередь продолжает использовать свой прежний отбор операций. Expired, history reset, redacted result, invalid epoch и namespace refusal сохраняют draft и полный handle. Обрабатываются также исторические имена `TT_HISTORY_RESET` и `TT_RESULT_REDACTED`.

Переход в review и освобождение соответствующего conflict gate выполняются одной транзакцией IndexedDB/SQLite. Неотправленные dependent rows переводятся из состояния конфликтной группы в pending с прежними ID и dependency references. Reviewed head блокирует только свою цепочку. Независимые допустимые операции могут синхронизироваться.

Удаляется только разрешённая conflict metadata; unknown operations не удаляются. Повторное открытие приложения или старое нажатие `chooseMine` не отправляет reviewed attempt. Сверка остаётся в существующем sync indicator. `bindAttempt` не может заново активировать review. Параллельное «Оставить серверное» проверяет статусы в транзакции и не удаляет pending unknown или ACKed-unreconciled попытку.

## Регрессионные проверки

Первоначальные N01/N02 воспроизведены восемью падающими проверками на исходном коде для IndexedDB и SQLite. Те же assertions проходят после исправления. Дополнительные проверки покрывают terminal codes, v1/v2/v3, потерю всех ACK, ошибку внутри реальной storage ACK transaction, restart, dependent chains, независимое новое намерение, account switch, отмену, поздний ответ, две копии sync module с общим lock и изменение attempt между preflight и транзакцией rebase.

```text
npm run test:unit -- tests/offline-conflict-recovery.test.ts tests/offline-conflict-recovery-native.test.ts tests/offline-web-storage.test.ts tests/offline-native-storage.test.ts tests/offline-sync.test.ts
node scripts/run-release-acceptance.mjs ui
```

Новые browser cases встроены в существующий обязательный UI acceptance script. Они используют отдельные PostgreSQL/Auth/PostgREST/Realtime, synthetic accounts и собственные persistent browser profiles. Для потери ответа прокси сначала получает реальный server commit, передаёт HTTP headers и обрывает response body; это исключает смешение browser transport retransmission с application retry. Проверяются Chromium и WebKit, полный browser restart, exact handle replay, отсутствие второго эффекта и ложного конфликта, отдельное новое намерение, один terminal POST, зависимая цепочка и независимая операция, reload и доступность read-only review.

Эти проверки не заменяют физическую Android/iOS/OTA приёмку. F07, production cutover, backup/PITR, remote release CI и scope/expiry security exception остаются отдельными условиями выпуска. Commit, push, deploy и production migrations этой фазой не выполняются.

В Windows-прогоне Playwright WebKit persistent profile после restart сохранил IndexedDB/full handles, но CacheStorage не содержал precached файлов приложения, хотя Service Worker был active. Bootstrap корректно оставался partial; принудительный ready не применялся. Проверки PWA с прежними assertions выполняются отдельно в стандартном browser context, а новые recovery cases требуют настоящего server-confirmed runtime config и кэша пункта. Это наблюдение тестовой среды требует отдельного подтверждения применимости к реальному Safari/PWA и не выдаётся за физическую платформенную приёмку.
