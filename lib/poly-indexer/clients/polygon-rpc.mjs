/**
 * Polygon JSON-RPC client (read-only). No transaction submission.
 * Env: POLYGON_RPC_URL (default https://polygon-rpc.com), POLYGON_WS_URL (optional, for subscriptions).
 */

const DEFAULT_RPC = "https://polygon-rpc.com";
const DEFAULT_WS = "wss://polygon-bor.publicnode.com";

function rpcUrl() {
  return process.env.POLYGON_RPC_URL?.trim() || DEFAULT_RPC;
}

function wsUrl() {
  return process.env.POLYGON_WS_URL?.trim() || DEFAULT_WS;
}

function normalizeRpcError(err) {
  if (err == null) return new Error("unknown RPC error");
  if (typeof err === "string") return new Error(err);
  if (typeof err.message === "string") return new Error(err.message);
  return new Error(JSON.stringify(err));
}

/**
 * @param {string} method
 * @param {unknown[]} params
 * @param {{ timeoutMs?: number; retries?: number }} [options]
 */
export async function jsonRpc(method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 3;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(rpcUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: attempt + 1,
          method,
          params,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
      }
      const json = await res.json();
      if (json.error) {
        throw normalizeRpcError(json.error);
      }
      return json.result;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const backoff = 100 * 2 ** attempt + Math.floor(Math.random() * 80);
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr ?? new Error("RPC failed");
}

/**
 * `eth_getBlockReceipts` (EIP-4321 / client support on Polygon Bor).
 * @param {bigint | number | string} blockNumber
 * @returns {Promise<unknown[]>}
 */
export async function getBlockReceipts(blockNumber) {
  const hex =
    typeof blockNumber === "bigint"
      ? "0x" + blockNumber.toString(16)
      : typeof blockNumber === "number"
        ? "0x" + blockNumber.toString(16)
        : blockNumber;
  return jsonRpc("eth_getBlockReceipts", [hex]);
}

/**
 * @param {{ fromBlock: string; toBlock: string; address?: string; topics?: (string|null)[] }} filter
 */
export async function getLogs(filter) {
  return jsonRpc("eth_getLogs", [filter]);
}

/**
 * Subscribe to new heads via WebSocket (`eth_subscribe` / `newHeads`).
 * Yields block objects as returned by the node.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* subscribeNewBlocks(options = {}) {
  const { default: WebSocket } = await import("ws");
  const url = wsUrl();
  const ws = new WebSocket(url);
  const signal = options.signal;

  let done = false;
  const queue = [];
  let waiter = /** @type {(() => void) | null} */ (null);

  function finish() {
    if (done) return;
    done = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    waiter?.();
  }

  if (signal) {
    signal.addEventListener("abort", finish, { once: true });
  }

  await new Promise((resolve, reject) => {
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_subscribe",
          params: ["newHeads"],
        }),
      );
      resolve(undefined);
    });
    ws.once("error", reject);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if ("id" in msg && msg.result != null && !msg.method) {
      return;
    }
    if (msg.method === "eth_subscription" && msg.params?.result != null) {
      queue.push(msg.params.result);
      const w = waiter;
      waiter = null;
      w?.();
    }
  });

  ws.on("error", finish);
  ws.on("close", finish);

  while (!done) {
    while (queue.length && !done) {
      yield queue.shift();
    }
    if (done) break;
    await new Promise((r) => {
      waiter = r;
    });
  }
}
