-- Video support (2026-11-08). Additive: the deployed `api` still refuses videos until v12 ships.
--   · events.max_video_bytes — per-video cap (default 2 GiB); photos keep max_file_bytes.
--   · media.kind ('photo' | 'video') and media.duration_s (seconds, from the phone, optional).
--   · uploader_intent takes kind + duration per upload and applies the right cap.
--   · uploader_hello reports maxVideoBytes.
--   · uploader_mine also lists this phone's unfinished uploads (started, never completed), so the
--     page can ask for them again on the next visit.
--   · video_requests.link — a guest whose video is over the cap pastes a share link instead.
--   · Videos upload with the resumable (TUS) endpoint using the public anon key. Storage RLS
--     lets anon write ONLY an object path that `intent` created for a video and that is still
--     waiting (state intent/failed, < 7 days old) — the same gate the signed PUT URLs give photos.
--   · `media` bucket limit raised to 2 GiB (the project-level upload limit must be raised in the
--     dashboard too; storage enforces the smaller of the two).
-- NOTE: uploader_hello / uploader_intent / uploader_mine / uploader_owner_status were replaced again
-- by 20261109011856_media_private.sql; the versions here are kept for history.

alter table public.events add column if not exists max_video_bytes bigint not null default 2147483648;
alter table public.media  add column if not exists kind text not null default 'photo';
alter table public.media  drop constraint if exists media_kind_check;
alter table public.media  add constraint media_kind_check check (kind in ('photo', 'video'));
alter table public.media  add column if not exists duration_s integer;
create index if not exists media_storage_path_idx on public.media (storage_path);
create index if not exists media_event_kind_idx on public.media (event_id, kind) where state = 'received';

alter table public.video_requests add column if not exists link text;
alter table public.video_requests alter column contact drop not null;
alter table public.video_requests drop constraint if exists video_requests_contact_or_link;
alter table public.video_requests add constraint video_requests_contact_or_link check (contact is not null or link is not null);

update storage.buckets set file_size_limit = 2147483648 where id = 'media';

create or replace function public.uploader_hello(p_token text)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare ev public.events; n_rec bigint; n_people bigint;
begin
  select * into ev from public.events where token = p_token;
  if not found or not ev.active then
    return jsonb_build_object('ok', false, 'code', 401, 'error', 'invalid link');
  end if;
  select count(*), count(distinct nullif(lower(btrim(contributor)), ''))
    into n_rec, n_people
    from public.media where event_id = ev.id and state = 'received' and outtake_at is null and deleted_at is null;
  return jsonb_build_object('ok', true, 'title', ev.title, 'received', n_rec, 'contributors', n_people,
    'windowOpen', (ev.starts_at is null or ev.starts_at <= now()) and (ev.ends_at is null or now() <= ev.ends_at),
    'maxBatch', ev.max_files_per_batch, 'maxFileBytes', ev.max_file_bytes, 'maxVideoBytes', ev.max_video_bytes);
end $function$;

create or replace function public.uploader_intent(p_token text, p_device text, p_contributor text, p_uploads jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  ev public.events;
  used bigint; incoming bigint;
  u jsonb; ex record;
  v_id text; v_sha text; v_name text; v_size bigint; v_thumb_wanted boolean;
  v_kind text; v_dur integer; v_max bigint;
  v_path text; v_thumb text;
  seen text[] := '{}';
  out jsonb := '[]'::jsonb;
begin
  select * into ev from public.events where token = p_token;
  if not found or not ev.active then
    return jsonb_build_object('ok', false, 'code', 401, 'error', 'invalid link');
  end if;
  if not ((ev.starts_at is null or ev.starts_at <= now()) and (ev.ends_at is null or now() <= ev.ends_at)) then
    return jsonb_build_object('ok', false, 'code', 403, 'error', 'uploads are closed for this event');
  end if;
  if jsonb_typeof(p_uploads) <> 'array' or jsonb_array_length(p_uploads) = 0 then
    return jsonb_build_object('ok', false, 'code', 400, 'error', 'no files');
  end if;
  if jsonb_array_length(p_uploads) > ev.max_files_per_batch then
    return jsonb_build_object('ok', false, 'code', 400, 'error', format('max %s files per batch', ev.max_files_per_batch));
  end if;
  if coalesce(ev.max_total_bytes, 0) > 0 then
    select coalesce(sum(byte_size), 0) into used
      from public.media where event_id = ev.id and state in ('received', 'intent');
    -- only files that pass their own per-file limit count toward the cap check
    select coalesce(sum(s), 0) into incoming
      from (select nullif(x->>'size', '')::bigint as s,
                   case when x->>'kind' = 'video' then ev.max_video_bytes else ev.max_file_bytes end as lim
              from jsonb_array_elements(p_uploads) x) z
     where s > 0 and s <= lim;
    if used + incoming > ev.max_total_bytes then
      return jsonb_build_object('ok', false, 'code', 403, 'error', 'the event photo storage is full — please tell the couple');
    end if;
  end if;

  for u in select value from jsonb_array_elements(p_uploads) loop
    v_id := u->>'uploadId';
    v_name := u->>'name';
    v_sha := nullif(u->>'sha256', '');
    v_size := nullif(u->>'size', '')::bigint;
    v_thumb_wanted := coalesce((u->>'thumb')::boolean, false);
    v_kind := case when u->>'kind' = 'video' then 'video' else 'photo' end;
    v_dur := case when (u->>'duration') ~ '^[0-9]{1,6}$' then (u->>'duration')::integer end;
    v_max := case when v_kind = 'video' then ev.max_video_bytes else ev.max_file_bytes end;

    if v_size is null or v_size <= 0 or v_size > v_max then
      out := out || jsonb_build_object('uploadId', v_id, 'status', 'too_large', 'max', v_max, 'kind', v_kind);
      continue;
    end if;

    select state, storage_path, thumb_path, kind into ex
      from public.media where event_id = ev.id and upload_id = v_id;
    if found then
      if ex.state = 'received' then
        out := out || jsonb_build_object('uploadId', v_id, 'status', 'received', 'kind', ex.kind);
        continue;
      end if;
      update public.media set
          device_key = coalesce(device_key, p_device),
          thumb_path = coalesce(thumb_path, case when v_thumb_wanted then ev.slug || '/thumbs/' || v_id || '.jpg' end),
          sha256 = coalesce(sha256, v_sha),
          duration_s = coalesce(duration_s, v_dur),
          state = case when state = 'failed' then 'intent' else state end
        where event_id = ev.id and upload_id = v_id
        returning storage_path, thumb_path into v_path, v_thumb;
      out := out || jsonb_build_object('uploadId', v_id, 'status', 'sign', 'path', v_path, 'thumbPath', v_thumb, 'kind', ex.kind);
      continue;
    end if;

    if v_sha is not null and (v_sha = any(seen) or exists (
        select 1 from public.media where event_id = ev.id and state = 'received' and outtake_at is null and deleted_at is null and sha256 = v_sha)) then
      out := out || jsonb_build_object('uploadId', v_id, 'status', 'duplicate', 'kind', v_kind);
      continue;
    end if;
    if v_sha is not null then seen := seen || v_sha; end if;

    v_path := ev.slug || '/' || v_id || '__' || v_name;
    v_thumb := case when v_thumb_wanted then ev.slug || '/thumbs/' || v_id || '.jpg' end;
    insert into public.media (event_id, upload_id, contributor, orig_name, content_type, byte_size,
                              storage_path, state, device_key, thumb_path, sha256, kind, duration_s)
      values (ev.id, v_id, nullif(p_contributor, ''), v_name, nullif(u->>'type', ''), v_size,
              v_path, 'intent', p_device, v_thumb, v_sha, v_kind, v_dur)
      on conflict (event_id, upload_id) do nothing;
    out := out || jsonb_build_object('uploadId', v_id, 'status', 'sign', 'path', v_path, 'thumbPath', v_thumb, 'kind', v_kind);
  end loop;

  return jsonb_build_object('ok', true, 'uploads', out);
end $function$;

create or replace function public.uploader_mine(p_token text, p_device text)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare ev public.events; items jsonb; unfinished jsonb;
begin
  select * into ev from public.events where token = p_token;
  if not found or not ev.active then
    return jsonb_build_object('ok', false, 'code', 401, 'error', 'invalid link');
  end if;
  select jsonb_agg(jsonb_build_object('uploadId', s.upload_id, 'name', s.orig_name, 'bytes', s.byte_size,
                                      'at', s.received_at, 'thumbPath', s.thumb_path, 'kind', s.kind, 'duration', s.duration_s)
                   order by s.received_at desc)
    into items
    from (select upload_id, orig_name, byte_size, received_at, thumb_path, kind, duration_s
            from public.media
           where event_id = ev.id and device_key = p_device and state = 'received' and outtake_at is null and deleted_at is null
           order by received_at desc limit 300) s;
  -- what this phone started in the last 7 days and never finished: the page asks for these again
  select jsonb_agg(jsonb_build_object('uploadId', u.upload_id, 'name', u.orig_name, 'bytes', u.byte_size,
                                      'kind', u.kind, 'at', u.created_at) order by u.created_at desc)
    into unfinished
    from (select upload_id, orig_name, byte_size, kind, created_at
            from public.media
           where event_id = ev.id and device_key = p_device and state in ('intent', 'failed')
             and created_at > now() - interval '7 days'
           order by created_at desc limit 50) u;
  return jsonb_build_object('ok', true, 'items', coalesce(items, '[]'::jsonb), 'unfinished', coalesce(unfinished, '[]'::jsonb));
end $function$;

create or replace function public.uploader_owner_status(p_token text, p_owner text)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare ev public.events; c jsonb; people jsonb; vids jsonb; who text;
begin
  select * into ev from public.events where token = p_token;
  if not found or not ev.active then
    return jsonb_build_object('ok', false, 'code', 401, 'error', 'invalid link');
  end if;
  who := public.uploader_admin_name(ev.id, p_owner);
  if who is null then
    return jsonb_build_object('ok', false, 'code', 401, 'error', 'owner token required');
  end if;
  select jsonb_build_object(
      'received', count(*) filter (where state = 'received' and deleted_at is null),
      'videos', count(*) filter (where state = 'received' and kind = 'video' and outtake_at is null and deleted_at is null),
      'pending', count(*) filter (where state = 'intent'),
      'failed', count(*) filter (where state = 'failed'),
      'hidden', count(*) filter (where state = 'received' and hidden and outtake_at is null and deleted_at is null),
      'outtakes', count(*) filter (where state = 'received' and outtake_at is not null and deleted_at is null),
      'approved', count(*) filter (where state = 'received' and approved_at is not null and outtake_at is null and not hidden and deleted_at is null),
      'unapproved', count(*) filter (where state = 'received' and approved_at is null and outtake_at is null and not hidden and deleted_at is null),
      'deleted', count(*) filter (where state = 'received' and deleted_at is not null),
      'totalBytes', coalesce(sum(byte_size) filter (where state = 'received'), 0),
      'capBytes', coalesce(ev.max_total_bytes, 0))
    into c from public.media where event_id = ev.id;
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into people from (
    select coalesce(nullif(btrim(contributor), ''), '(no name)') as k, count(*) as n
      from public.media where event_id = ev.id and state = 'received' and outtake_at is null and deleted_at is null group by 1) s;
  select coalesce(jsonb_agg(jsonb_build_object('name', v.name, 'contact', v.contact, 'link', v.link, 'at', v.created_at) order by v.created_at desc), '[]'::jsonb)
    into vids from (select name, contact, link, created_at from public.video_requests
                     where event_id = ev.id order by created_at desc limit 200) v;
  return jsonb_build_object('ok', true, 'title', ev.title, 'albumPublic', ev.album_public, 'admin', who,
    'windowOpen', (ev.starts_at is null or ev.starts_at <= now()) and (ev.ends_at is null or now() <= ev.ends_at),
    'opensAt', ev.starts_at, 'closesAt', ev.ends_at,
    'counts', c, 'contributors', people, 'videos', vids);
end $function$;

-- Resumable (TUS) uploads for videos: anon may write exactly the paths `intent` opened for a video.
create or replace function public.uploader_upload_allowed(p_name text)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.media m
     where m.storage_path = p_name and m.kind = 'video'
       and m.state in ('intent', 'failed') and m.created_at > now() - interval '7 days');
$function$;
revoke all on function public.uploader_upload_allowed(text) from public;
grant execute on function public.uploader_upload_allowed(text) to anon, authenticated, service_role;

drop policy if exists "uploader video resumable insert" on storage.objects;
drop policy if exists "uploader video resumable update" on storage.objects;
drop policy if exists "uploader video resumable select" on storage.objects;
create policy "uploader video resumable insert" on storage.objects for insert to anon
  with check (bucket_id = 'media' and public.uploader_upload_allowed(name));
create policy "uploader video resumable update" on storage.objects for update to anon
  using (bucket_id = 'media' and public.uploader_upload_allowed(name))
  with check (bucket_id = 'media' and public.uploader_upload_allowed(name));
create policy "uploader video resumable select" on storage.objects for select to anon
  using (bucket_id = 'media' and public.uploader_upload_allowed(name));
