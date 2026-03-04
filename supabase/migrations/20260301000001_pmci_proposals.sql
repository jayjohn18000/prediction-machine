-- PMCI Phase 2: proposed links and review decisions (politics proposer → review queue)
-- RELATIONSHIP_MANAGER: schema for propose→review→accept pipeline

-- Proposed links: candidate (provider_market_id_a, provider_market_id_b) with confidence + reasons
-- Canonical ordering: id_a < id_b to avoid duplicate (a,b) vs (b,a)
create table if not exists pmci.proposed_links (
  id                         bigserial primary key,
  category                   text not null default 'politics',
  provider_market_id_a       bigint not null references pmci.provider_markets(id) on delete cascade,
  provider_market_id_b        bigint not null references pmci.provider_markets(id) on delete cascade,
  proposed_relationship_type text not null check (proposed_relationship_type in ('equivalent','proxy')),
  confidence                 numeric(5,4) not null,
  reasons                    jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),

  decision                   text null check (decision in ('accepted','rejected','skipped')),
  reviewed_at                 timestamptz null,
  reviewer_note               text null,
  accepted_family_id          bigint null references pmci.market_families(id) on delete set null,
  accepted_link_version      int null,
  accepted_relationship_type  text null check (accepted_relationship_type is null or accepted_relationship_type in ('equivalent','proxy')),

  constraint ux_pmci_proposed_links_pair_type unique (provider_market_id_a, provider_market_id_b, proposed_relationship_type),
  constraint chk_proposed_links_canonical check (provider_market_id_a < provider_market_id_b)
);

create index if not exists idx_pmci_proposed_links_category_decision_created
  on pmci.proposed_links(category, decision, created_at desc);
create index if not exists idx_pmci_proposed_links_confidence
  on pmci.proposed_links(confidence desc);
create index if not exists idx_pmci_proposed_links_pair
  on pmci.proposed_links(provider_market_id_a, provider_market_id_b);

-- Review decisions: one row per decision (accept/reject/skip) for audit
create table if not exists pmci.review_decisions (
  id               bigserial primary key,
  proposed_link_id bigint not null references pmci.proposed_links(id) on delete cascade,
  decision         text not null check (decision in ('accepted','rejected','skipped')),
  relationship_type text null check (relationship_type is null or relationship_type in ('equivalent','proxy')),
  reviewer_note    text null,
  reviewed_at      timestamptz not null default now()
);

create index if not exists idx_pmci_review_decisions_proposed_link
  on pmci.review_decisions(proposed_link_id);
