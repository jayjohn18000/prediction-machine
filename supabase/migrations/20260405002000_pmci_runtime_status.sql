create table if not exists pmci.pmci_runtime_status (
  id integer primary key,
  latest_snapshot_at timestamptz,
  latest_kalshi_snapshot_at timestamptz,
  latest_polymarket_snapshot_at timestamptz,
  provider_markets_count integer not null default 0,
  snapshot_count integer not null default 0,
  families_count integer not null default 0,
  current_links_count integer not null default 0,
  observer_last_run timestamptz,
  updated_at timestamptz not null default now(),
  constraint pmci_runtime_status_single_row check (id = 1)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pmci_runtime_status_single_row'
  ) then
    alter table pmci.pmci_runtime_status
      add constraint pmci_runtime_status_single_row check (id = 1);
  end if;
end $$;
