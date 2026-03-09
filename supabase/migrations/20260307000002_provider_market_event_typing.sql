-- D7 — election_phase and subject_type on provider_markets for primary vs general and candidate vs party alignment
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS election_phase text
    CHECK (election_phase IN ('primary', 'general', 'runoff', 'special', 'unknown')),
  ADD COLUMN IF NOT EXISTS subject_type text
    CHECK (subject_type IN ('candidate', 'party', 'policy', 'appointment', 'unknown'));

COMMENT ON COLUMN pmci.provider_markets.election_phase IS
  'Election phase: primary, general, runoff, special. NULL = not yet classified.';
COMMENT ON COLUMN pmci.provider_markets.subject_type IS
  'What the market resolves on: candidate, party, policy, appointment.';
