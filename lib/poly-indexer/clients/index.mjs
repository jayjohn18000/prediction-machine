/**
 * READ-ONLY namespace. CI lint (`npm run lint:poly-write-guard`) refuses modules
 * that import HTTP clients against `clob.polymarket.com` or `polymarket.com/api`
 * from outside `lib/poly-indexer/clients/polygon-rpc.mjs` and
 * `lib/poly-indexer/clients/polymarket-subgraph.mjs`.
 */

export {
  jsonRpc,
  getBlockReceipts,
  getLogs,
  subscribeNewBlocks,
} from "./polygon-rpc.mjs";
export {
  subgraphGet,
  RESOLVED_MARKETS_QUERY,
  TRADES_QUERY,
} from "./polymarket-subgraph.mjs";
