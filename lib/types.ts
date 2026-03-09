export interface ProviderMarket {
  id: number;
  provider_id: number;
  provider_market_ref: string;
  event_ref: string | null;
  title: string;
  category: string | null;
  status: string;
  metadata: Record<string, unknown>;
  // Phase 2: populated from OpenAI embeddings, stored in pgvector column
  title_embedding: number[] | null;
}

export interface MatchingFields {
  template: string;
  jurisdiction: string | null;
  cycle: number | null;
  party: string | null;
  candidateName: string | null;
  resolutionYear: number | null;
}

export type RelationshipType = 'equivalent' | 'proxy' | 'correlated';

export interface LinkFeatures {
  title_jaccard: number;
  entity_overlap: number | null;
  date_delta_days: number | null;
  outcome_name_match: number | null;
  // Phase 2: cosine similarity between Kalshi and Polymarket title embeddings
  embedding_cosine_similarity: number | null;
  confidence_raw: number;
  template: string;
}

export interface ProposedLink {
  kalshi_market_id: number;
  poly_market_id: number;
  relationship_type: RelationshipType;
  confidence: number;
  features: LinkFeatures;
}

