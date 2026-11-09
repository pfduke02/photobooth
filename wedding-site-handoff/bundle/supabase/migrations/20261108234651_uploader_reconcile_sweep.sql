-- uploader_reconcile: safety net for uploads whose `complete` call never arrived.
-- Found 2026-11-08: 8 wedding photos from 3 guests sat in state 'intent' with the file fully
-- in storage (size matches), because the page was closed or the `complete` request failed
-- after the upload itself had finished. They were invisible to the album, admin and the guest.
-- Every 10 minutes: intents whose object is in storage with the declared size → received
-- (received_at = when the file actually landed); intents with no object after 48 h → failed
-- (a retry with the same uploadId reopens them, as uploader_intent already does).

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

create index if not exists media_intent_idx on public.media (created_at) where state = 'intent';

create or replace function public.uploader_reconcile(p_min_age interval default interval '2 minutes',
                                                     p_fail_after interval default interval '48 hours')
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare n_rec integer := 0; n_fail integer := 0;
begin
  with m as (
    select me.id, o.created_at as uploaded_at,
           coalesce(nullif(o.metadata->>'size', '')::bigint, nullif(o.metadata->>'contentLength', '')::bigint) as actual
      from public.media me
      join storage.objects o
        on o.bucket_id = 'media' and o.name collate "C" = me.storage_path and o.archived_at is null
     where me.state = 'intent' and me.created_at < now() - p_min_age
  ),
  good as (
    update public.media t
       set state = 'received', byte_size = m.actual, received_at = coalesce(m.uploaded_at, now())
      from m
     where t.id = m.id and m.actual > 0 and (t.byte_size is null or t.byte_size = m.actual)
    returning t.id
  )
  select count(*) into n_rec from good;

  update public.media me
     set state = 'failed'
   where me.state = 'intent' and me.created_at < now() - p_fail_after
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'media' and o.name collate "C" = me.storage_path and o.archived_at is null);
  get diagnostics n_fail = row_count;

  return jsonb_build_object('ok', true, 'received', n_rec, 'failed', n_fail);
end $$;

revoke all on function public.uploader_reconcile(interval, interval) from public;
revoke all on function public.uploader_reconcile(interval, interval) from anon, authenticated;

select cron.unschedule('uploader-reconcile') where exists (select 1 from cron.job where jobname = 'uploader-reconcile');
select cron.schedule('uploader-reconcile', '*/10 * * * *', $job$ select public.uploader_reconcile(); $job$);
