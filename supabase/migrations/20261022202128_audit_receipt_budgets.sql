begin;
set local lock_timeout='5s';
lock table private.client_operation_receipts in share row exclusive mode;

-- NULL policy is deliberately unconfigured: known receipts replay, new writes
-- fail closed until an operator sets measured limits. No production guesses.
create table private.client_operation_policy (
  singleton boolean primary key default true check(singleton),
  max_receipts bigint check(max_receipts>0), max_logical_bytes bigint check(max_logical_bytes>0),
  max_request_bytes integer check(max_request_bytes>0), max_result_bytes integer check(max_result_bytes>0),
  new_per_minute integer check(new_per_minute>0)
);
insert into private.client_operation_policy(singleton) values(true);
create table private.client_operation_budgets (
  user_id uuid primary key, receipt_count bigint not null default 0 check(receipt_count>=0),
  logical_bytes bigint not null default 0 check(logical_bytes>=0),
  window_start timestamptz, window_count integer not null default 0 check(window_count>=0)
);
alter table private.client_operation_policy enable row level security;
alter table private.client_operation_budgets enable row level security;
revoke all on private.client_operation_policy,private.client_operation_budgets from public,anon,authenticated,service_role;

create function private.canonical_receipt_request(p_value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then select coalesce(jsonb_object_agg(key,private.canonical_receipt_request(value)),'{}') into v_result from jsonb_each(p_value);
    when 'array' then select coalesce(jsonb_agg(private.canonical_receipt_request(value) order by ord),'[]') into v_result from jsonb_array_elements(p_value) with ordinality a(value,ord);
    when 'number' then v_result:=to_jsonb(trim_scale((p_value#>>'{}')::numeric));
    else v_result:=p_value;
  end case;
  return v_result;
end $$;
create function private.receipt_request_hash(p_type text,p_target uuid,p_payload jsonb) returns bytea
language sql immutable set search_path='' as $$
  select sha256(convert_to(private.canonical_receipt_request(jsonb_build_array(p_type,p_target,p_payload))::text,'UTF8'))
$$;
revoke all on function private.canonical_receipt_request(jsonb),private.receipt_request_hash(text,uuid,jsonb) from public,anon,authenticated,service_role;

alter table private.client_operation_receipts
  add column fingerprint_version smallint not null default 1 check(fingerprint_version=1),
  add column request_fingerprint bytea,
  add column accounted_bytes bigint not null default 0 check(accounted_bytes>=0),
  add column result_limit integer;
alter table private.client_operation_receipts alter column request_payload drop not null;
update private.client_operation_receipts set request_fingerprint=private.receipt_request_hash(operation_type,task_item_id,request_payload),
  request_payload=null,accounted_bytes=128+octet_length(operation_type)+coalesce(octet_length(result_payload::text),0);
alter table private.client_operation_receipts alter column request_fingerprint set not null;
alter table private.client_operation_receipts add constraint receipt_fingerprint_size check(octet_length(request_fingerprint)=32);
insert into private.client_operation_budgets(user_id,receipt_count,logical_bytes)
select user_id,count(*),sum(accounted_bytes) from private.client_operation_receipts group by user_id;

create function private.account_client_operation() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_policy private.client_operation_policy%rowtype; v_budget private.client_operation_budgets%rowtype;
  v_window timestamptz:=date_trunc('minute',clock_timestamp()); v_bytes bigint; v_base bigint;
begin
  if tg_op='INSERT' then
    select * into v_policy from private.client_operation_policy where singleton;
    if v_policy.max_receipts is null or v_policy.max_logical_bytes is null or v_policy.max_request_bytes is null
      or v_policy.max_result_bytes is null or v_policy.new_per_minute is null then
      raise exception 'Receipt limits require configuration' using errcode='PT503',detail='TT_RECEIPT_POLICY'; end if;
    if new.request_payload is null or octet_length(new.request_payload::text)>v_policy.max_request_bytes then
      raise exception 'Operation request exceeds receipt limit' using errcode='PT413',detail='TT_RECEIPT_LIMIT'; end if;
    insert into private.client_operation_budgets(user_id) values(new.user_id) on conflict do nothing;
    select * into v_budget from private.client_operation_budgets where user_id=new.user_id for update;
    v_window:=date_trunc('minute',clock_timestamp());
    v_base:=128+octet_length(new.operation_type); v_bytes:=v_base+v_policy.max_result_bytes;
    if v_budget.receipt_count>=v_policy.max_receipts or v_budget.logical_bytes+v_bytes>v_policy.max_logical_bytes then
      raise exception 'Operation receipt storage budget exhausted' using errcode='PT507',detail='TT_RECEIPT_LIMIT'; end if;
    if v_budget.window_start=v_window and v_budget.window_count>=v_policy.new_per_minute then
      raise exception 'Operation receipt rate limit' using errcode='PT429',detail='TT_RECEIPT_RATE'; end if;
    update private.client_operation_budgets set receipt_count=receipt_count+1,logical_bytes=logical_bytes+v_bytes,
      window_count=case when window_start=v_window then window_count+1 else 1 end,window_start=v_window where user_id=new.user_id;
    new.request_fingerprint:=private.receipt_request_hash(new.operation_type,new.task_item_id,new.request_payload);
    new.request_payload:=null; new.fingerprint_version:=1; new.accounted_bytes:=v_bytes; new.result_limit:=v_policy.max_result_bytes;
    return new;
  end if;
  perform 1 from private.client_operation_budgets where user_id=old.user_id for update;
  if tg_op='DELETE' then
    if old.completed_at is not null then raise exception 'Completed receipts cannot be removed' using errcode='22023'; end if;
    update private.client_operation_budgets set receipt_count=receipt_count-1,logical_bytes=logical_bytes-old.accounted_bytes where user_id=old.user_id;
    return old;
  end if;
  if (new.user_id,new.operation_id,new.operation_type,new.task_item_id,new.request_fingerprint,new.fingerprint_version)
    is distinct from (old.user_id,old.operation_id,old.operation_type,old.task_item_id,old.request_fingerprint,old.fingerprint_version)
    or new.request_payload is not null then raise exception 'Receipt identity is immutable' using errcode='22023'; end if;
  if old.completed_at is not null and (new.result_payload,new.completed_at) is distinct from (old.result_payload,old.completed_at) then
    raise exception 'Completed receipt result is immutable' using errcode='22023'; end if;
  if new.result_payload is not null then
    if old.result_limit is not null and octet_length(new.result_payload::text)>old.result_limit then
      raise exception 'Operation result exceeds reserved receipt budget' using errcode='PT507',detail='TT_RECEIPT_LIMIT'; end if;
    v_bytes:=128+octet_length(new.operation_type)+octet_length(new.result_payload::text);
    update private.client_operation_budgets set logical_bytes=logical_bytes-old.accounted_bytes+v_bytes where user_id=old.user_id;
    new.accounted_bytes:=v_bytes;
  else new.accounted_bytes:=old.accounted_bytes; end if;
  new.result_limit:=old.result_limit;
  return new;
end $$;
revoke all on function private.account_client_operation() from public,anon,authenticated,service_role;
create trigger trg_client_operation_budget before insert or update or delete on private.client_operation_receipts
  for each row execute function private.account_client_operation();

create or replace function private.claim_client_operation(p_operation_id uuid,p_operation_type text,p_task_item_id uuid,p_request_payload jsonb)
returns table(claimed boolean,saved_result jsonb) language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.require_auth(); v_receipt private.client_operation_receipts%rowtype;
begin
  if p_operation_id is null or p_task_item_id is null then raise exception 'operation id and target required' using errcode='22023'; end if;
  if p_operation_type is null or p_request_payload is null then raise exception 'operation type and payload required' using errcode='22023'; end if;
  select * into v_receipt from private.client_operation_receipts where user_id=v_user and operation_id=p_operation_id;
  if not found then
    -- One admission lock per account; recheck after waiting for a concurrent commit.
    insert into private.client_operation_budgets(user_id) values(v_user) on conflict do nothing;
    perform 1 from private.client_operation_budgets where user_id=v_user for update;
    select * into v_receipt from private.client_operation_receipts where user_id=v_user and operation_id=p_operation_id;
    if not found then
      insert into private.client_operation_receipts(user_id,operation_id,operation_type,task_item_id,request_payload)
        values(v_user,p_operation_id,p_operation_type,p_task_item_id,p_request_payload);
      return query select true,null::jsonb; return;
    end if;
  end if;
  if v_receipt.operation_type is distinct from p_operation_type or v_receipt.task_item_id is distinct from p_task_item_id
    or v_receipt.request_fingerprint is distinct from private.receipt_request_hash(p_operation_type,p_task_item_id,p_request_payload) then
    raise exception 'operation_id reused with different request' using errcode='22023'; end if;
  if v_receipt.completed_at is null then raise exception 'operation receipt incomplete' using errcode='40001'; end if;
  return query select false,v_receipt.result_payload;
end $$;
revoke all on function private.claim_client_operation(uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
