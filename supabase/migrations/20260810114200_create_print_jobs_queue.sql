create table if not exists public.print_jobs (
  id          text primary key,
  created_at  timestamptz not null default now(),
  image_path  text not null,
  status      text not null default 'pending',   -- pending | printing | done | error
  copies      integer not null default 1,
  printed_at  timestamptz,
  error       text,
  meta        jsonb
);

create index if not exists print_jobs_status_idx on public.print_jobs (status, created_at);

alter table public.print_jobs enable row level security;

-- The Mac watcher authenticates with the public anon key (a single trusted local
-- process at the event). It needs to read pending jobs and mark them printing/done.
drop policy if exists print_jobs_anon_select on public.print_jobs;
create policy print_jobs_anon_select on public.print_jobs
  for select to anon using (true);

drop policy if exists print_jobs_anon_update on public.print_jobs;
create policy print_jobs_anon_update on public.print_jobs
  for update to anon using (true) with check (true);

-- Inserts happen only through the `print` Edge Function (service role bypasses RLS).
-- No anon insert policy, on purpose.
