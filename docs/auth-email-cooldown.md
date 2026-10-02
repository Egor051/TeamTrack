# UX Auth-email: анализ, реализация и проверка

Дата исходной реализации: 2026-10-02. Изменения только в приложении, без изменений Supabase. Исходная проверка выполнялась без commit/push/deploy; последующая публикация Git разрешена отдельным поручением пользователя.

## Найденные сценарии и исходное поведение

Все отправляющие вызовы приложения централизованы в `src/features/auth/auth.ts`, вызываются через `AuthProvider.tsx`.

| Сценарий | Экран и метод | Исходная обработка | Изменение |
| --- | --- | --- | --- |
| Регистрация с подтверждением email | `register.tsx` → `signUp` → POST `/signup` | Уведомление «Проверьте почту», ошибки через `mapSupabaseAuthError`; resend отсутствовал | 60 секунд после успешного ответа без session; добавлена resend-кнопка |
| Повторное подтверждение | Ранее отсутствовало | На входе `email_not_confirmed` показывал только ошибку | `resendConfirmation` → `resend({ type: 'signup' })` → POST `/resend`; кнопка после регистрации и после `email_not_confirmed` на входе |
| Восстановление пароля | `forgot-password.tsx` → `requestPasswordReset` → POST `/recover` | Условное уведомление для существующего аккаунта; общее сообщение при ошибке; только «Указать другой email» | Cooldown первой и повторной отправки, resend-кнопка, общий русский mapper ошибок |

Ранее не было ни countdown, ни сохранённых сроков ожидания. Вход по паролю использует `/token` и письма не отправляет. `reset-password.tsx` вызывает `updateUser({ password })`, без смены email и без запроса письма/reauthentication. Серверная notification о смене пароля — отдельная опциональная настройка; в локальном config она закомментирована. Production-настройки notifications не проверялись, UX для повторной отправки такой notification в приложении отсутствует.

Magic link/OTP, `inviteUserByEmail`, смены email и `reauthenticate()` в пользовательских сценариях нет. Приглашения участников проекта не являются Supabase Auth invite. Технические тестовые скрипты не являются пользовательскими email-flow и не изменялись.

## Изменённые файлы

- `src/app/(auth)/register.tsx`
- `src/app/(auth)/forgot-password.tsx`
- `src/app/(auth)/login.tsx`
- `src/features/auth/auth.ts`
- `src/features/auth/AuthProvider.tsx`
- `src/lib/errors/auth-errors.ts`
- `src/features/auth/email-cooldown.ts` — новый helper
- `src/features/auth/use-email-cooldown.ts` — новый hook
- `tests/auth-email-cooldown.test.ts` — новые проверки сервиса
- `tests/auth-email-ui.test.tsx` — новые UI/lifecycle проверки
- `docs/auth-email-cooldown.md` — этот отчёт

## Cooldown и persistence

После успешного запроса сохраняется `Date.now() + 60_000`. Отображение: `max(0, ceil((until - now) / 1000))`. Таймер лишь обновляет текущее время; decrement-счётчика нет.

Используется установленный в проекте AsyncStorage: браузерный localStorage на web, AsyncStorage на native. Ключ `auth-email-cooldown:<signup|recovery>:<email.trim().toLowerCase()>`, значение — только timestamp. Email присутствует только в ключе конкретной операции; пароли, токены, SMTP/API secrets не сохраняются.

Первичная и повторная отправка подтверждения используют общий `signup` cooldown. Восстановление имеет независимый `recovery` cooldown: Supabase проверяет `ConfirmationSentAt` и `RecoverySentAt` отдельно. Это подтверждено в [исходниках Supabase Auth](https://github.com/supabase/auth/blob/master/internal/api/mail.go). Другие адреса не блокируются.

Hook восстанавливает срок после remount/reload, отключает кнопку до завершения чтения persistence, перечитывает срок на web focus/visibility, native foreground и событии `storage` другой вкладки. Истёкшие и некорректные значения удаляются при чтении; активный ключ удаляется после завершения отсчёта. Очистка остальных неиспользуемых истёкших ключей происходит при следующем обращении к ним.

Сервис проверяет тот же срок перед каждым запросом, включая Enter и autofill без React-события, и запрещает параллельную отправку для одной операции/email в текущем runtime. Чтение/запись/удаление persistence сериализованы по ключу. При недоступном storage отправка не превращается в ошибку: остаётся cooldown в памяти, действующий до закрытия/перезагрузки runtime.

Во время ожидания используется существующий Button с disabled и текстом «Отправить повторно через N с». Во время запроса сохраняется spinner/loading. Countdown находится вне live region, `accessibilityLiveRegion="none"`, accessible label не меняется каждую секунду. Таймер, подписки и слушатели снимаются при unmount; поздние результаты не обновляют закрытый экран.

## Серверные ошибки

Только `over_email_send_rate_limit` имеет специальный email UX. Если message точно соответствует `For security purposes, you can only request this after N seconds.`, helper восстанавливает срок из этого оставшегося интервала. Supabase округляет его вниз, поэтому добавлена одна секунда для отброшенной дробной части; например ответ 12 означает локальное ожидание до 13 секунд. Такой формат подтверждён в [generateFrequencyLimitErrorMessage](https://github.com/supabase/auth/blob/master/internal/api/errors.go).

Без надёжного remaining time выводится «Отправка писем временно ограничена. Попробуйте ещё раз позже.» и новый deadline не придумывается. Это важно: общий hourly email limit в Supabase может возвращать тот же код. `over_request_rate_limit` получает собственное русское сообщение без email-countdown. HTTP 429, произвольные числа в message и «once every 60 seconds» не используются как оставшееся время.

Network, invalid-email, SMTP и прочие ошибки передаются из сервиса без изменения, отображаются через существующий mapper и не запускают cooldown. Recovery использует тот же mapper вместо прежнего общего сообщения для любых ошибок. Успешный signup с session не запускает ожидание подтверждения. Условный текст восстановления не раскрывает, зарегистрирован ли адрес.

## Выполненная проверка

- `npm test` — PASS: политика DB URL, TypeScript, ESLint, 29 файлов / 269 тестов.
- В том числе 36 новых тестов: 22 сервиса/errors и 14 UI/lifecycle. Покрыты A–I из задания, loading, повторный запуск после expiry, нормализация email, независимость flow, global limit, смена адреса на login, native/web resume, storage event, cleanup и отказ persistence.
- `npm run build:web` — PASS: production Expo static export, 35 маршрутов, `dist/sw.js` с 6 precached файлами.
- React review: зависимости effects, единственный активный интервал на hook, cleanup, отсутствие ticking live announcements, существующий Button/стили.

Auth API в новых тестах замокан: реальные письма через Postbox, production rate limit, доставка письма и открытие новой resend-ссылки на физическом устройстве не проверялись. PKCE redirect options проверены на уровне вызовов; existing auth-link tests прошли. Новый browser/native test stack не добавлялся.

## Ручная проверка перед выпуском

Использовать тестовую среду с подтверждением email и интервалом 60 секунд. Локальный Supabase config этого checkout содержит `max_frequency = "1s"`; он не изменялся. Поэтому без подходящей тестовой среды нельзя считать локальный backend доказательством production-интервала 60 секунд.

1. Зарегистрировать тестовый аккаунт. Проверить disabled «Отправить повторно через 60 с», затем 59…1. Через минуту нажать resend; убедиться в новом письме, рабочей PKCE-ссылке и новом отсчёте.
2. Выйти на login, ввести адрес неподтверждённого аккаунта и пароль. После `email_not_confirmed` проверить resend-кнопку и общий срок с регистрацией. Изменить email: предложение подтверждения прежнего адреса должно исчезнуть.
3. Запросить восстановление. Проверить уведомление, resend/loading, disabled, повторное письмо после минуты и действие «Указать другой email». Другой адрес должен быть доступен независимо.
4. Во время countdown обновить страницу, перейти назад/вперёд и снова ввести тот же email. Срок должен продолжаться, а не начинаться заново или исчезать. Повторить с разным регистром и пробелами.
5. Отправить вкладку/приложение в background на время больше минуты и вернуть. Кнопка должна стать активной по текущему времени. Повторить с двумя вкладками: storage update должен обновить cooldown второй вкладки.
6. В Network проверить отсутствие дополнительных запросов по быстрым кликам и Enter. Эмулировать offline/SMTP error: ожидание не должно начинаться, ошибка должна оставаться ошибкой отправки.
7. В тестовой среде вызвать раннюю отправку с другого runtime. Для remaining-time message проверить русский текст и восстановление срока. Для общего лимита проверить русское сообщение без выдуманных секунд и без success-уведомления.
8. Проверить narrow mobile viewport и screen reader: disabled/busy понятны, каждую секунду нет объявления нового числа. На native проверить возврат из background.

## Ограничения

Supabase остаётся источником истины: окончание UI-cooldown не гарантирует отправку при других лимитах. Удаление storage, другой браузер/устройство и одновременная отправка из двух вкладок могут достигнуть сервера; ошибка обрабатывается. Storage-события распространяют сохранённый cooldown, но не являются межвкладочным mutex. Изменение системных часов влияет на Date.now-based отображение; серверный лимит при этом сохраняет силу. Persistence-недоступность исключает гарантию восстановления после reload, но не блокирует успешную отправку.

Миграции, RLS/RPC/schema, credentials, Postbox и production Supabase configuration не изменялись. При исходной реализации commit, push и deploy не выполнялись. После отдельного поручения пользователя перед публикацией повторно запускаются `npm test`, `npm run typecheck`, `npm run lint` и `npm run build:web`; результат commit/push сообщается отдельно. Ручной deploy не входит в это поручение.
