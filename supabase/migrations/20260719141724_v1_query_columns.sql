alter table public.sessions
  add column if not exists ai_enabled  boolean,
  add column if not exists app_version text,
  add column if not exists favorite    boolean not null default false,
  add column if not exists tags        text[]  not null default '{}',
  add column if not exists note        text;
