-- Metadata for every photobooth session
create table if not exists public.sessions (
  id          text primary key,
  created_at  timestamptz not null default now(),
  num_photos  int,
  background  text,
  strip_theme text,
  strip_path  text,
  frame_paths text[],
  meta        jsonb
);

-- Anyone can READ session metadata (public/shareable gallery); writes happen
-- only via the Edge Function using the service role (which bypasses RLS).
alter table public.sessions enable row level security;
drop policy if exists "sessions public read" on public.sessions;
create policy "sessions public read" on public.sessions
  for select to anon, authenticated using (true);

-- Public storage bucket for strips + frames (unlisted in practice: served by
-- unguessable per-session paths; can switch to signed URLs/auth later).
insert into storage.buckets (id, name, public)
values ('sessions', 'sessions', true)
on conflict (id) do update set public = excluded.public;
