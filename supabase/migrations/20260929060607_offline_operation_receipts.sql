-- A receipt and its canonical mutation commit in the same RPC transaction.
-- Receipts are deliberately retained indefinitely; deleting one would permit replay.
create table private.client_operation_receipts (
    user_id uuid not null,
    operation_id uuid not null,
    operation_type text not null,
    task_item_id uuid not null,
    request_payload jsonb not null,
    result_payload jsonb,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    primary key (user_id, operation_id),
    constraint client_operation_receipts_completed_pair
        check ((result_payload is null) = (completed_at is null))
);

alter table private.client_operation_receipts enable row level security;
revoke all on private.client_operation_receipts from public, anon, authenticated;

-- INSERT .. ON CONFLICT waits for a concurrent claimant's transaction. A
-- successful claimant's receipt is visible to the next statement; rollback
-- instead lets the waiter claim and execute the mutation itself.
create function private.claim_client_operation(
    p_operation_id uuid,
    p_operation_type text,
    p_task_item_id uuid,
    p_request_payload jsonb
)
returns table (claimed boolean, saved_result jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user uuid := private.require_auth();
    v_receipt private.client_operation_receipts%rowtype;
    v_claim_count integer;
begin
    if p_operation_id is null or p_task_item_id is null then
        raise exception 'operation id and task item id are required' using errcode = '22023';
    end if;
    insert into private.client_operation_receipts
        (user_id, operation_id, operation_type, task_item_id, request_payload)
    values (v_user, p_operation_id, p_operation_type, p_task_item_id, p_request_payload)
    on conflict (user_id, operation_id) do nothing;
    get diagnostics v_claim_count = row_count;
    if v_claim_count > 0 then
        return query select true, null::jsonb;
        return;
    end if;

    select * into v_receipt
      from private.client_operation_receipts
     where user_id = v_user and operation_id = p_operation_id;
    if not found then
        raise exception 'operation receipt unavailable' using errcode = '40001';
    end if;
    if v_receipt.operation_type is distinct from p_operation_type
       or v_receipt.task_item_id is distinct from p_task_item_id
       or v_receipt.request_payload is distinct from p_request_payload then
        raise exception 'operation_id reused with different request' using errcode = '22023';
    end if;
    if v_receipt.completed_at is null then
        raise exception 'operation receipt incomplete' using errcode = '40001';
    end if;
    return query select false, v_receipt.result_payload;
end;
$$;

revoke all on function private.claim_client_operation(uuid, text, uuid, jsonb) from public, anon, authenticated;

create function public.apply_task_item_state_operation(
    p_operation_id uuid, p_task_item_id uuid, p_completed boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user uuid := private.require_auth();
    v_claimed boolean;
    v_saved jsonb;
    v_result boolean;
begin
    select claimed, saved_result into v_claimed, v_saved
      from private.claim_client_operation(p_operation_id, 'set_task_item_state',
        p_task_item_id, pg_catalog.jsonb_build_object('completed', p_completed));
    if not v_claimed then return (v_saved #>> '{}')::boolean; end if;
    v_result := public.set_task_item_state(p_task_item_id, p_completed);
    update private.client_operation_receipts
       set result_payload = pg_catalog.to_jsonb(v_result), completed_at = now()
     where user_id = v_user and operation_id = p_operation_id;
    return v_result;
end;
$$;

create function public.apply_task_item_percentage_operation(
    p_operation_id uuid, p_task_item_id uuid, p_percentage integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user uuid := private.require_auth();
    v_claimed boolean;
    v_saved jsonb;
    v_result integer;
begin
    select claimed, saved_result into v_claimed, v_saved
      from private.claim_client_operation(p_operation_id, 'set_task_item_percentage',
        p_task_item_id, pg_catalog.jsonb_build_object('percentage', p_percentage));
    if not v_claimed then return (v_saved #>> '{}')::integer; end if;
    v_result := public.set_task_item_percentage(p_task_item_id, p_percentage);
    update private.client_operation_receipts
       set result_payload = pg_catalog.to_jsonb(v_result), completed_at = now()
     where user_id = v_user and operation_id = p_operation_id;
    return v_result;
end;
$$;

create function public.apply_task_item_comment_operation(
    p_operation_id uuid, p_task_item_id uuid, p_comment text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user uuid := private.require_auth();
    v_comment text := nullif(pg_catalog.btrim(coalesce(p_comment, '')), '');
    v_claimed boolean;
    v_saved jsonb;
begin
    select claimed, saved_result into v_claimed, v_saved
      from private.claim_client_operation(p_operation_id, 'set_task_item_comment',
        p_task_item_id, pg_catalog.jsonb_build_object('comment', v_comment));
    if not v_claimed then return v_saved ->> 'comment'; end if;
    perform public.set_task_item_comment(p_task_item_id, v_comment);
    update private.client_operation_receipts
       set result_payload = pg_catalog.jsonb_build_object('comment', v_comment), completed_at = now()
     where user_id = v_user and operation_id = p_operation_id;
    return v_comment;
end;
$$;

revoke execute on function public.apply_task_item_state_operation(uuid, uuid, boolean) from public, anon;
revoke execute on function public.apply_task_item_percentage_operation(uuid, uuid, integer) from public, anon;
revoke execute on function public.apply_task_item_comment_operation(uuid, uuid, text) from public, anon;
grant execute on function public.apply_task_item_state_operation(uuid, uuid, boolean) to authenticated;
grant execute on function public.apply_task_item_percentage_operation(uuid, uuid, integer) to authenticated;
grant execute on function public.apply_task_item_comment_operation(uuid, uuid, text) to authenticated;
