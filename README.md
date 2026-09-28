# TaskTrace

TaskTrace — кроссплатформенное приложение для командной работы с проектами,
этапами и чек-листами. Клиент работает на React Native и Expo Router, а
аутентификация, хранение данных, RLS, RPC, audit history, notifications и
Realtime работают через Supabase.

В пользовательском интерфейсе подраздел проекта называется этапом. Внутренние
таблицы, RPC, маршруты и типы сохраняют идентификатор `task` для совместимости
с существующим контрактом данных.

Репозиторий содержит production-oriented реализацию с закрытым mutation API:
чувствительные изменения выполняются атомарными PostgreSQL RPC, а прямые
`INSERT`/`UPDATE`/`DELETE` для роли `authenticated` ограничены RLS и ACL.

## Возможности

- регистрация, вход, выход, восстановление и смена пароля через Supabase Auth;
- проекты с ролями `owner`, `admin`, `member`, `viewer`;
- приглашение участников проекта по email или идентификатору;
- участник проекта автоматически наследует свою роль во всех этапах;
  `task_members.role_override` позволяет owner/admin отдельно повысить или
  понизить только права чек-листа, не меняя права проекта;
- назначение исполнителей через `task_assignees`;
- чек-листы с изменением состояния и редактированием пунктов;
- автоматический статус этапа по активным пунктам чек-листа:
  `not_started`, `in_progress`, `completed`;
- архивирование и восстановление проектов и этапов;
- атомарное архивирование всех активных этапов при архивировании проекта;
- сохранение границы между этапом, архивированным проектом, и этапом,
  архивированным отдельно;
- immutable история действий чек-листа в `item_actions`;
- подробный immutable `audit_log`;
- контекстные уведомления о доступе, назначениях, чек-листах и archive/restore;
- приватный Supabase Broadcast для invalidation проекта, этапа и уведомлений;
- статический web export и запуск на Android/iOS через Expo.

## Стек

- React 19 и React Native 0.86;
- Expo SDK 57 и Expo Router 57;
- TypeScript 6;
- Supabase JS 2;
- Supabase PostgreSQL 17;
- Supabase Auth PKCE и private Broadcast Realtime;
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
порт `55432`: это локальная native-операция Supabase CLI. Для hosted
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

Приложение использует PKCE и reverse-domain scheme
`com.teamtrack.tasktrace` для native signup/recovery callbacks. Клиент принимает
только точные маршруты `login` и `reset-password`, назначение `auth_type`, code и
`sb_flow_id`; implicit-flow tokens и произвольные callback-параметры отвергаются.
Для web Expo Router генерирует статический export.

## Локальный Supabase

Запустите локальный stack из корня проекта:

```bash
npx --yes supabase@2.116.0 start
```

Основные локальные адреса из `supabase/config.toml`:

| Сервис | Адрес/порт |
| --- | --- |
| Supabase API | `http://127.0.0.1:55431` |
| PostgreSQL | `127.0.0.1:55432` |
| Supabase Studio | `http://127.0.0.1:55433` |
| Email testing UI | `http://127.0.0.1:55434` |
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

Профиль первоначально создаётся серверным trigger из Auth metadata, после чего
каноническим источником становится `public.profiles`. Чтение/самовосстановление
идёт через `get_my_profile()`, изменение — только через `update_my_profile()`.
Последующие изменения Auth metadata не перезаписывают профиль, а прямой UPDATE
таблицы клиенту не выдан.

Для hosted проекта настройте в Supabase Dashboard:

1. Site URL и точные PKCE callback URL для web;
2. `com.teamtrack.tasktrace://**` для native PKCE callbacks; точный endpoint
   дополнительно проверяется клиентом до обмена кода;
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
| Просмотр проекта и всех его этапов | да | да | да | да |
| Создание этапов | да | да | да | нет |
| Изменение прогресса/комментария чек-листа | да | да | да | нет |
| Изменение структуры чек-листа | да | да | нет | нет |
| Управление участниками проекта | да | только `member`/`viewer` | нет | нет |
| Управление checklist override | да | только `member`/`viewer` | нет | нет |
| Управление исполнителями | да | да | нет | нет |
| Редактирование/архивирование проекта | да | да | нет | нет |
| Архивирование/восстановление этапа | да | да | нет | нет |
| Передача ownership | да | нет | нет | нет |

Дополнительные правила:

- наличие `project_members` даёт доступ ко всей вложенной структуре проекта,
  включая существующие и будущие этапы, чек-листы и пункты;
- для каждой пары «этап × участник проекта» существует `task_members`-строка;
  `role_override = null` означает наследование `project_members.role`;
- override влияет только на checklist API: он не даёт права редактировать этап,
  участников проекта или исполнителей;
- assignee обязан быть участником проекта;
- удаление участника проекта атомарно удаляет его task role state и
  assignees, после чего проектная роль больше не даёт доступа;
- owner нельзя удалить до передачи ownership;
- viewer остаётся read-only;
- archived project и archived task не допускают writable checklist mutations.

Все проектные mutation RPC сначала блокируют project row, затем task/item и
строки ролей в одном порядке. Authorization и active/archived state проверяются
по текущим `FOR UPDATE`-строкам после ожидания lock, поэтому concurrent revoke,
role override и archive не могут завершиться записью из устаревшего snapshot.

## Жизненный цикл проекта, этапа и чек-листа

Статус этапа вычисляется базой по активным (`is_archived = false`) пунктам:

- нет активных пунктов или все активные пункты unchecked → `not_started`;
- часть активных пунктов checked → `in_progress`;
- все активные пункты checked → `completed`;
- archived task (этап) всегда остаётся `archived`.

Изменение checkbox выполняется только через `set_task_item_state()`. В одной
транзакции обновляются `task_items`, `item_actions`, `audit_log` и связанные
notifications.

Архивирование проекта:

1. блокирует строку проекта;
2. архивирует все его активные этапы в той же транзакции;
3. записывает audit events и отправляет scoped notifications.

Восстановление проекта возвращает только этапы, которые были архивированы
именно этой операцией. Этап, архивированный отдельно через `archive_task()`,
остаётся archived. Для него owner/admin может вызвать `restore_task()`, если
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
- `get_my_task_role`, `list_task_member_overrides`,
  `set_task_member_override`, `clear_task_member_override`;
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
- закрыты для `anon` и `service_role`; нужные функции явно выдаются только
  `authenticated`. `service_role` используется для Auth administration, но не
  является скрытым CRUD/RPC API application tables.

Прямой `INSERT`/`UPDATE`/`DELETE` для application tables закрыт ACL/RLS.
`task_items.is_completed` нельзя изменить обходя `set_task_item_state()`.
Названия ограничены 500 символами, description/comment — 10 000 символами как
в RPC, так и storage constraints.
Сгенерированные типы находятся в `src/types/database.types.ts`; файл не нужно
редактировать вручную.

## Audit, history и notifications

`item_actions` — append-only история checkbox transitions. `audit_log` хранит
создание, изменение, membership, assignment, archive/restore и другие
значимые события с PostgreSQL timestamps и actor из `auth.uid()`.
Owner/admin видят всю историю своего проекта; profile history доступна только
самому пользователю; история templates доступна их создателю.

Уведомления создаются внутренней функцией `private.audit_to_notification()`:

- получатели вычисляются из project/task membership, а не из client-provided
  recipient id;
- actor не получает собственное уведомление;
- `audit:<audit_id>` используется как dedupe key;
- поддерживаются project/task archive и restore, access, assignee и checklist
  events;
- RLS позволяет пользователю читать и отмечать только свои notifications.

## Realtime

Application tables исключены из publication `supabase_realtime`: Postgres
Changes не используется, в том числе для DELETE, где row-level фильтрация не
может безопасно скрыть старую строку.

Database triggers отправляют минимальные private Broadcast invalidations на
точные topics `project:<uuid>`, `task:<uuid>` и `user:<uuid>`. Payload содержит
только table/operation и непрозрачный message id, без данных строки. Realtime
Authorization разрешает topic по текущей membership; клиент multiplex-ит один
channel на topic, закрывает resource channels при изменении прав и всегда
перечитывает данные через RLS/RPC. Realtime не является источником данных или
авторизации.

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
запускает семь наборов:

- `initial_schema_smoke_test.sql`;
- `stage_visibility_test.sql`;
- `rls_and_rpc_test.sql`;
- `notifications_test.sql`;
- `full_integration_test.sql`;
- `hard_delete_history_test.sql`;
- `task_enhancements_test.sql`.

`npm run test:backend` дополнительно проверяет реальные локальные GoTrue и
PostgREST запросы, private Realtime WebSocket, отсутствие Postgres Changes,
web/native PKCE через Mailpit и автоматические two-session concurrency races.

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
3. настройте точные web PKCE callbacks и native scheme
   `com.teamtrack.tasktrace://**`;
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
