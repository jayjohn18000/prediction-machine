-- Phase E1.1: sports market fields

ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS sport text,
  ADD COLUMN IF NOT EXISTS event_type text CHECK (event_type IN ('game_result','season_award','draft_pick','player_prop','championship','unknown')),
  ADD COLUMN IF NOT EXISTS game_date date,
  ADD COLUMN IF NOT EXISTS home_team text,
  ADD COLUMN IF NOT EXISTS away_team text;

COMMENT ON COLUMN pmci.provider_markets.sport IS 'Sport code: nfl, nba, mlb, nhl, soccer, etc.';
COMMENT ON COLUMN pmci.provider_markets.event_type IS 'Sports market type';
COMMENT ON COLUMN pmci.provider_markets.game_date IS 'Game/event date for short-lived markets';
COMMENT ON COLUMN pmci.provider_markets.home_team IS 'Home team name for team-vs-team sports markets';
COMMENT ON COLUMN pmci.provider_markets.away_team IS 'Away team name for team-vs-team sports markets';

ALTER TABLE pmci.canonical_events
  ADD COLUMN IF NOT EXISTS lifecycle text CHECK (lifecycle IN ('active','settled','archived','cancelled')) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS resolves_at timestamptz;

COMMENT ON COLUMN pmci.canonical_events.lifecycle IS 'Lifecycle state for canonical events';
COMMENT ON COLUMN pmci.canonical_events.resolves_at IS 'Timestamp when event resolves/settles';
