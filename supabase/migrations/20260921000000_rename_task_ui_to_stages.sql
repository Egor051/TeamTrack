-- Keep the database/API entity named task while presenting it as an "этап"
-- in user-facing notifications. Restrict normalization to task-linked rows.

create or replace function private.normalize_stage_notification_terminology()
returns trigger
language plpgsql
set search_path = public, private
as $$
begin
    if new.task_id is null then
        return new;
    end if;

    new.title := replace(new.title, 'Доступ к задаче', 'Доступ к этапу');
    new.title := replace(new.title, 'Задача архивирована', 'Этап архивирован');
    new.title := replace(new.title, 'Задача восстановлена', 'Этап восстановлен');

    new.body := replace(new.body, 'доступ к задаче', 'доступ к этапу');
    new.body := replace(new.body, 'Вас добавили в задачу', 'Вас добавили в этап');
    new.body := replace(new.body, 'Ваш доступ к задаче был отозван', 'Ваш доступ к этапу был отозван');
    new.body := replace(new.body, 'назначили ответственным за задачу', 'назначили ответственным за этап');
    new.body := replace(new.body, 'назначены исполнителем задачи', 'назначены исполнителем этапа');
    new.body := replace(new.body, 'назначение в задаче', 'назначение на этапе');
    new.body := replace(new.body, '→ задача «', '→ этап «');
    new.body := replace(new.body, 'в задаче «', 'на этапе «');
    new.body := replace(new.body, 'Задача «', 'Этап «');

    return new;
end
$$;

revoke all on function private.normalize_stage_notification_terminology()
from public, anon, authenticated, service_role;

drop trigger if exists trg_normalize_stage_notification_terminology on public.notifications;
create trigger trg_normalize_stage_notification_terminology
before insert or update of title, body, task_id on public.notifications
for each row execute function private.normalize_stage_notification_terminology();

update public.notifications
set title = title,
    body = body
where task_id is not null;
