-- Canonical mapping tables for events, markets, and outcomes.
-- Do not modify existing tables, edge_windows, or execution views.

CREATE TABLE IF NOT EXISTS public.canonical_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text,
  region text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.canonical_markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_event_id uuid REFERENCES public.canonical_events(id) ON DELETE CASCADE,
  title text NOT NULL,
  resolves_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.canonical_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_market_id uuid REFERENCES public.canonical_markets(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.provider_event_map (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  canonical_event_id uuid REFERENCES public.canonical_events(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS public.provider_market_map (
  provider text NOT NULL,
  provider_market_id text NOT NULL,
  canonical_market_id uuid REFERENCES public.canonical_markets(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_market_id)
);

CREATE TABLE IF NOT EXISTS public.provider_outcome_map (
  provider text NOT NULL,
  provider_outcome_id text NOT NULL,
  canonical_outcome_id uuid REFERENCES public.canonical_outcomes(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_outcome_id)
);
