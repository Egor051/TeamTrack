-- READ ONLY. Supabase Dashboard SQL Editor, trusted administrative context.
-- Do not grant these queries or diagnostic SELECT to application users.
begin read only;

-- 1. Latest errors (all times below are explicit UTC).
select received_at,occurred_at,user_id,event_id,app_version,app_build,kind,operation,stage,description,
       event->'error' as exception,event->>'network_issue' as network_issue,event->'capabilities' as capabilities,
       event->'cache' as cache,event->'outbox' as outbox,event->'displayed_version' as displayed_version,event->'server_version' as server_version
from public.client_error_logs
where received_at>=now()-interval '14 days'
order by received_at desc limit 100;

-- 2. One user and time range. Replace only the quoted UUID and timestamps.
select received_at,event_id,kind,operation,stage,description,event
from public.client_error_logs
where user_id='00000000-0000-0000-0000-000000000000'::uuid
  and received_at>='2026-10-28T13:00:00Z'::timestamptz
  and received_at<'2026-10-28T14:00:00Z'::timestamptz
order by received_at;

-- 3. Common types/causes and affected users.
select kind,stage,operation,event#>>'{error,code}' as code,count(*) as events,count(distinct user_id) as users
from public.client_error_logs where received_at>=now()-interval '14 days'
group by 1,2,3,4 order by events desc limit 50;

-- 4. A specific immutable build (or filter app_version separately).
select received_at,user_id,event_id,kind,stage,description,event
from public.client_error_logs
where app_build='REPLACE_WITH_BUILD_HEX' and received_at>=now()-interval '14 days'
order by received_at desc limit 100;

-- 5. Physical footprint and actual serialized size. Does not inspect any files.
select pg_size_pretty(pg_total_relation_size('public.client_error_logs')) as table_and_indexes,
       count(*) as rows,round(avg(octet_length(convert_to(to_jsonb(l)::text,'UTF8')))) as average_serialized_bytes,
       max(octet_length(convert_to(to_jsonb(l)::text,'UTF8'))) as largest_serialized_bytes,
       count(*) filter(where received_at<now()-interval '14 days') as cleanup_backlog
from public.client_error_logs l;

-- 6. Retention schedule and failures. Requires existing pg_cron.
select jobname,schedule,active,command from cron.job where jobname='tasktrace-client-error-retention';
select d.start_time,d.end_time,d.status,d.return_message
from cron.job_run_details d join cron.job j on j.jobid=d.jobid
where j.jobname='tasktrace-client-error-retention'
order by d.start_time desc limit 24;

rollback;
