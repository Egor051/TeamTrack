# TaskTrace

TaskTrace — кроссплатформенное приложение для командной работы с проектами,
задачами и чек-листами. Клиент работает на React Native и Expo Router, а
аутентификация, хранение данных, RLS, RPC, audit history, notifications и
Realtime работают через Supabase.

Репозиторий содержит production-oriented реализацию с закрытым mutation API:
чувствительные изменения выполняются атомарными PostgreSQL RPC, а прямые
`INSERT`/`UPDATE`/`DELETE` для роли `authenticated` ограничены RLS и ACL.

## Возможности

- регистрация, вход, выход, восстановление и смена пароля через Supabase Auth;
- проекты с ролями `owner`, `admin`, `member`, `viewer`;
- приглашение участников проекта по email или идентификатору;
- задачи и доступ к задачам через отдельную таблицу `task_members`;
- назначение исполнителей через `task_assignees`;
- чек-листы с изменением состояния и редактированием пунктов;
- автоматический статус задачи по активным пунктам чек-листа:
  `not_started`, `in_progress`, `completed`;
- архивирование и восстановление проектов и задач;
- атомарное архивирование всех активных задач при архивировании проекта;
- сохранение границы между задачей, архивированной проектом, и задачей,
  архивированной отдельно;
- immutable история действий чек-листа в `item_actions`;
- подробный immutable `audit_log`;
- контекстные уведомления о доступе, назначениях, чек-листах и archive/restore;
- Supabase Realtime для обновлений проекта, задачи, истории и уведомлений;
- статический web export и запуск на Android/iOS через Expo.

## Стек

- React 19 и React Native 0.86;
- Expo SDK 57 и Expo Router 57;
- TypeScript 6;
- Supabase JS 2;
- Supabase PostgreSQL 17;
- Supabase Auth и Postgres Changes Realtime;
- ESLint с `eslint-config-expo`;
- Docker для локального Supabase stack.

Версии Expo и Supabase CLI фиксируются в `package.json` и скриптах. Для
воспроизводимых операций с базой используйте Supabase CLI `2.116.0`, как в
`scripts/run-sql-tests.mjs` и `scripts/gen-types.mjs`.

## Структура проекта

```text
src/
  app/                         Expo Router routes
  components/ui/               общие UI-компоненты
  features/auth/               AuthProvider и auth API
  features/notifications/      загрузка и обработка уведомлений
  features/projects/           project/task client wrappers
  lib/supabase/                Supabase client и Realtime helpers
  types/database.types.ts     сгенерированные типы базы данных
supabase/
  migrations/                  канонический порядок SQL-миграций
  tests/                       RLS, RPC, notifications и integration tests
  config.toml                  локальная конфигурация Supabase
scripts/
  gen-types.mjs                генерация TypeScript типов
  run-sql-tests.mjs            reset базы и запуск SQL suites
assets/                        иконки и splash assets, используемые app.json
.github/workflows/ci.yml       статические и database CI jobs
```

## Требования

- Node.js 22 LTS рекомендуется, это версия, используемая в CI;
- npm;
- Docker Desktop, если нужны локальная база и SQL-тесты;
- аккаунт Supabase для hosted development или production.

Проверить окружение можно так:

```bash
node --version
npm --version
docker --version
```

## Установка и переменные окружения

Для воспроизводимой установки используйте:

```bash
npm ci
```

Для обычной локальной разработки также допустимо `npm install`.

Создайте локальный `.env` из шаблона:

```bash
cp .env.example .env
```

В PowerShell:

```powershell
Copy-Item .env.example .env
```

Заполните следующие значения:

```dotenv
# Публичная конфигурация клиента. Эти значения попадают в bundle.
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY

# Только локальные/server-side инструменты. В bundle они не попадают.
SUPABASE_DB_URL=<set only in ignored .env>
SUPABASE_PROJECT_ID=YOUR_PROJECT_REF
```

`SUPABASE_DB_URL` для локального `gen:types` намеренно указывает на direct
порт `54322`: это локальная native-операция Supabase CLI. Для hosted
подключения используйте Supavisor session mode (`*.pooler.supabase.com:5432`;
`sslmode=require`) либо `--project-id`/linked CLI. Hosted direct endpoint и
transaction mode для этого CLI-пути блокируются проверкой репозитория.

Правила безопасности:

- никогда не используйте `service_role`, database password или JWT secret в
  `EXPO_PUBLIC_*` переменных и в клиентском коде;
- `.env` игнорируется Git и не должен попадать в commit;
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` является публичным ключом, который защищается
  RLS и не заменяет серверную авторизацию;
- `SUPABASE_DB_URL` и реальные hosted credentials нельзя коммитить;
- `.env.example` содержит только placeholder/local development значения.

## Локальный запуск приложения

Запустите Expo dev server:

```bash
npm run start
```

Доступные shortcuts:

```bash
npm run web       # Expo web
npm run android   # Android emulator или устройство
npm run ios       # iOS simulator, macOS
```

Приложение использует scheme `tasktrace` для native recovery links. Для web
Expo Router генерирует статический export.

## Локальный Supabase

Запустите локальный stack из корня проекта:

```bash
npx --yes supabase@2.116.0 start
```

Основные локальные адреса из `supabase/config.toml`:

| Сервис | Адрес/порт |
| --- | --- |
| Supabase API | `http://127.0.0.1:54321` |
| PostgreSQL | `127.0.0.1:54322` |
| Supabase Studio | `http://127.0.0.1:54323` |
| Email testing UI | `http://127.0.0.1:54324` |
| Expo web по умолчанию | `http://localhost:8081` |

Остановить stack:

```bash
npx --yes supabase@2.116.0 stop
```

Локальная конфигурация включает Auth с подтверждением email, refresh token
rotation, минимальным паролем 8 символов и требованиями к регистру/цифрам.
Письма в local stack не отправляются наружу, а доступны в Email testing UI.

## Auth и session flow

`src/features/auth/AuthProvider.tsx` восстанавливает сохранённую Supabase
session, подписывается на изменения auth state и предоставляет операции:

- sign up;
- sign in with email/password;
- sign out с очисткой локальной session;
- запрос reset password;
- установка нового пароля после recovery link.

Native session хранится через Expo SecureStore, web session — через browser
совместимое хранилище. Route groups автоматически направляют пользователя в
`(auth)` или `(app)` и показывают bootstrap loading state во время проверки
session.

Профиль создаётся серверным trigger `on_auth_user_created` из миграции
`20260903000000_profile_provisioning.sql`. При регистрации display name берётся
из `raw_user_meta_data`, но это поле не используется для authorization.

Для hosted проекта настройте в Supabase Dashboard:

1. Site URL и полный allow-list redirect URL для web;
2. `tasktrace://reset-password` для native recovery;
3. leaked-password protection;
4. `secure_password_change`;
5. SMTP, rate limits и environment-specific callback URLs.

Проверяйте login, logout, истёкшую session, refresh, подтверждение email и
reset password отдельно для каждого окружения.

## Модель ролей и доступа

Роль хранится в `project_members.role`. Проверки выполняются на сервере через
RLS и RPC, поэтому скрытие кнопки в UI не является механизмом безопасности.

| Операция | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| Просмотр доступного проекта и задач | да | да | да | да |
| Создание задач | да | да | да | нет |
| Работа с пунктами чек-листа | да | да | да, если есть доступ к задаче | нет |
| Управление участниками проекта | да | да, в пределах своей роли | нет | нет |
| Управление `task_members` | да | да | нет | нет |
| Управление исполнителями | да | да | нет | нет |
| Редактирование/архивирование проекта | да | да | нет | нет |
| Архивирование/восстановление задачи | да | да | нет | нет |
| Передача ownership | да | нет | нет | нет |

Дополнительные правила:

- `task_members` видят только участники этой задачи и owner/admin её проекта;
- assignee обязан быть одновременно участником проекта и задачи;
- удаление участника проекта атомарно удаляет его task access и assignees;
- owner нельзя удалить до передачи ownership;
- viewer остаётся read-only;
- archived project и archived task не допускают writable checklist mutations.

## Жизненный цикл проекта, задачи и чек-листа

Статус задачи вычисляется базой по активным (`is_archived = false`) пунктам:

- нет активных пунктов или все активные пункты unchecked → `not_started`;
- часть активных пунктов checked → `in_progress`;
- все активные пункты checked → `completed`;
- archived task всегда остаётся `archived`.

Изменение checkbox выполняется только через `set_task_item_state()`. В одной
транзакции обновляются `task_items`, `item_actions`, `audit_log` и связанные
notifications.

Архивирование проекта:

1. блокирует строку проекта;
2. архивирует все его активные задачи в той же транзакции;
3. записывает audit events и отправляет scoped notifications.

Восстановление проекта возвращает только задачи, которые были архивированы
именно этой операцией. Задача, архивированная отдельно через `archive_task()`,
остаётся archived. Для неё owner/admin может вызвать `restore_task()`, если
проект активен.

## Supabase API и границы mutation

Клиентские wrappers находятся в `src/features/projects/projects.ts` и
`src/features/notifications/notifications.ts`. Чувствительные записи идут
через public RPC, среди которых:

- `create_project`, `update_project`;
- `create_task`, `create_task_item`, `update_task_item`;
- `set_task_item_state`, `archive_task_item`;
- `add_project_member`, `add_project_member_by_identifier`,
  `remove_project_member`, `change_member_role`,
  `transfer_project_ownership`;
- `approve_task_member`, `revoke_task_member`;
- `add_task_assignee`, `remove_task_assignee`;
- `archive_project`, `restore_project`, `archive_task`, `restore_task`;
- `mark_notification_read`, `mark_all_notifications_read`.

Все mutation RPC:

- требуют authenticated caller через `auth.uid()`;
- проверяют membership, ownership, role и active/archived state;
- используют `SECURITY DEFINER` только с фиксированным `search_path`;
- не принимают actor/user identity из клиентского payload;
- выполняются атомарно: исключение откатывает бизнес-изменение и audit side
  effects;
- закрыты для `anon`; нужные функции явно выдаются `authenticated`, а
  отдельные server-side операции также доступны `service_role`.

Прямой `INSERT`/`UPDATE`/`DELETE` для application tables закрыт ACL/RLS.
`task_items.is_completed` нельзя изменить обходя `set_task_item_state()`.
Сгенерированные типы находятся в `src/types/database.types.ts`; файл не нужно
редактировать вручную.

## Audit, history и notifications

`item_actions` — append-only история checkbox transitions. `audit_log` хранит
создание, изменение, membership, assignment, archive/restore и другие
значимые события с PostgreSQL timestamps и actor из `auth.uid()`.

Уведомления создаются внутренней функцией `private.audit_to_notification()`:

- получатели вычисляются из project/task membership, а не из client-provided
  recipient id;
- actor не получает собственное уведомление;
- `audit:<audit_id>` используется как dedupe key;
- поддерживаются project/task archive и restore, access, assignee и checklist
  events;
- RLS позволяет пользователю читать и отмечать только свои notifications.

## Realtime

В publication `supabase_realtime` включены:

- `projects`;
- `project_members`;
- `tasks`;
- `task_members`;
- `task_assignees`;
- `task_items`;
- `item_actions`;
- `audit_log`;
- `notifications`.

`src/lib/supabase/realtime.ts` создаёт scoped channels с фильтрами по
`project_id`, `task_id` или `user_id`. Клиент подписывается только на
`INSERT`/`UPDATE`: DELETE не используется как источник авторизации, потому что
после удаления строка уже не может быть проверена через RLS. После успешной
подписки UI повторяет initial fetch, а после mutation перечитывает актуальное
состояние. Realtime является механизмом обновления интерфейса, но не заменяет
RLS или RPC authorization.

## Миграции и схема

Канонический источник deployment schema — упорядоченные файлы
`supabase/migrations/*.sql`. Файл `tasktrace_schema.sql` в корне — только
исторический baseline и не должен применяться напрямую.

Проверить локальный порядок миграций:

```bash
npx --yes supabase@2.116.0 migration list --local
```

Создать новую миграцию:

```bash
npx --yes supabase@2.116.0 migration new descriptive_name
```

После изменений сначала проверьте их локально через reset и SQL suites. Для
hosted проекта используйте link и push только после code review:

```bash
npx --yes supabase@2.116.0 login
npx --yes supabase@2.116.0 link --project-ref YOUR_PROJECT_REF
npx --yes supabase@2.116.0 db push
npx --yes supabase@2.116.0 migration list
```

Перед hosted deploy проверьте, что версия PostgreSQL соответствует
`major_version = 17`, а dashboard auth settings и Realtime publication не
расходятся с локальной конфигурацией.

## Генерация типов

Из локальной базы с применёнными миграциями:

```bash
npm run gen:types
```

Из hosted проекта через linked Supabase CLI:

```bash
npm run gen:types -- --project-id
```

Первый вариант использует локальный direct URL или проверенный hosted pooler
URL, второй — `SUPABASE_PROJECT_ID` и авторизацию Supabase CLI. Linked CLI
проект TaskTrace сейчас использует `aws-0-eu-central-1.pooler.supabase.com:5432`
(Supavisor session mode). После генерации проверяйте
`git diff src/types/database.types.ts` и не коммитьте случайные типы от другой
схемы или окружения.

## Проверки и тесты

Базовые проверки клиента:

```bash
npm run typecheck
npm run lint
npm run test
```

`npm run test` запускает typecheck и lint.

SQL security/integration suites требуют запущенный Docker/Supabase stack:

```bash
npx --yes supabase@2.116.0 start
npm run test:sql
```

`npm run test:sql` делает local database reset, применяет все миграции и
запускает:

- `initial_schema_smoke_test.sql`;
- `rls_and_rpc_test.sql`;
- `notifications_test.sql`;
- `full_integration_test.sql`.

`supabase/tests/concurrency_test.sql` — manual two-session harness для проверки
блокировок и порядка audit/history.

Дополнительные production-oriented проверки:

```bash
npx --yes supabase@2.116.0 db lint --local
npx --yes supabase@2.116.0 db advisors --local --type security --level info
npm audit --omit=dev
npx expo-doctor
npx expo export --platform web
```

CI (`.github/workflows/ci.yml`) повторяет статические проверки и database
проверки на Ubuntu. Database job использует локальный Supabase и SQL suites.

## Hosted и EAS deployment

Перед release:

1. примените все migrations к нужному Supabase project;
2. проверьте `migration list`, RLS, grants, functions и publication;
3. настройте Auth redirect allow-list для web и `tasktrace://reset-password`;
4. задайте в EAS environment (`development`, `preview`, `production`) только
   `EXPO_PUBLIC_SUPABASE_URL` и публичный anon/publishable key;
5. никогда не добавляйте `service_role` или database credentials в app bundle;
6. выполните smoke-тесты owner/admin/member/viewer;
7. отдельно проверьте двумя пользователями concurrent checklist update,
   archive/restore, revoke access и notifications после reconnect.

Для production полезно проверить:

- подтверждение email и reset password с реальными redirect URLs;
- leaked-password protection и secure password change;
- session refresh и поведение при отозванной/истёкшей session;
- Realtime после reconnect и после initial fetch;
- отсутствие данных другого проекта при прямом открытии route;
- archive/restore notification recipients и read/unread semantics;
- резервное копирование и rollback plan для миграций.

## Полезные команды

```bash
# клиент
npm run start
npm run web
npm run android
npm run ios

# качество
npm run typecheck
npm run lint
npm run test

# база
npx --yes supabase@2.116.0 start
npm run test:sql
npx --yes supabase@2.116.0 db reset --local --yes
npx --yes supabase@2.116.0 stop
```

## Ограничения текущего scope

В текущей версии нет comments, subtasks и offline sync. Исторический baseline
также перечисляет их как будущие направления; не следует путать этот список с
поддерживаемым production API.

## Лицензия

Условия использования находятся в файле [LICENSE](LICENSE).
