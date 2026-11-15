// BSC Dust Approval Cleaner
//
// A read-only CLI agent that finds ERC-20 approvals a BSC wallet no longer
// needs: the token balance is zero, but a spender can still move tokens if
// any ever arrive (airdrop, mistaken transfer, dust). It lists those "dust
// approvals" with the revoke calldata needed to clear them.
//
// It never signs, never sends a transaction, never asks for a private key.
// It only reads public chain state through public BSC RPC endpoints.
//
// Usage:
//   node cleaner.mjs <wallet-address> [--json] [--out <file>] [--spenders a,b]
//   node cleaner.mjs 0xce6474737f8b0B4fa58F52d14299Bdd745232c01
//
// Exit codes: 0 = scan complete (even if dust found), 1 = usage error,
//             2 = scan failed (RPC/token-list unreachable).

const RPC_ENDPOINTS = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed1.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
  "https://bsc-dataseed3.bnbchain.org",
  "https://bsc-dataseed4.bnbchain.org",
];
const TOKEN_LIST_URL = "https://tokens.1inch.io/v1.1/56";
const BATCH_SIZE = 8;
const MAX_UINT256 = (1n << 256n) - 1n;

// Well-known BSC tokens, checked even when the public token list is down.
const CURATED_TOKENS = [
  { symbol: "A404", address: "0xB7E2f2D6ED4928F6fA774Ff9295D01f25aA17725", decimals: 18 },
  { symbol: "G404", address: "0xb6Ad15244d9c4b259D5080BE4900fba07fe5D8e8", decimals: 18 },
  { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  { symbol: "BUSD", address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", decimals: 18 },
  { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
  { symbol: "CAKE", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18 },
  { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
  { symbol: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
  { symbol: "DW", address: "0xC47Ce083F18776E711c4365Bc4daa283229Cb6CA", decimals: 18 },
];

// Well-known spenders: contracts a BSC wallet is likely to have approved.
// Names are labels only; the agent trusts no spender, it just reports.
const KNOWN_SPENDERS = [
  { name: "PancakeSwap V2 Router", address: "0x10ED43C718714eb63d5aA57B78B54704E256024E" },
  { name: "PancakeSwap V3 Router", address: "0x13f4EA83D0bd40E75C8222255bcEa5E54a705696" },
  { name: "Agent404 PASSDROP engine", address: "0xCD2401b13d66A37D04a7356d776162154Eb11719" },
  { name: "AGENTS MINE engine", address: "0x7d8e34cBbf5d171391f43154cc5B5334f40667c1" },
  { name: "Agent ID registry", address: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F" },
];

// ERC-20 selectors.
const SEL = {
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  approve: "0x095ea7b3",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad32 = (addr) => "0".repeat(24) + addr.slice(2).toLowerCase();
const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);

function parseArgs(argv) {
  const args = { address: null, json: false, out: null, extraSpenders: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--spenders") {
      args.extraSpenders = argv[++i].split(",").map((s) => s.trim()).filter(isAddress);
    } else if (!a.startsWith("--") && !args.address) args.address = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.address || !isAddress(args.address)) {
    throw new Error("usage: node cleaner.mjs <wallet-address> [--json] [--out <file>] [--spenders addr1,addr2]");
  }
  args.address = args.address.toLowerCase();
  return args;
}

// One JSON-RPC batch against the rotating endpoints. Returns the raw
// response array (entries may carry .error). Throws only if every
// endpoint fails the whole batch.
async function rpcBatch(calls) {
  const body = JSON.stringify(calls);
  let lastErr = null;
  for (const url of RPC_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) return data;
      return [data];
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  throw new Error(`all RPC endpoints failed: ${lastErr}`);
}

// Run many eth_calls, batched, with a progress note on stderr.
async function runCalls(items, onProgress) {
  const results = new Map();
  let id = 0;
  const calls = items.map((it) => ({ jsonrpc: "2.0", method: "eth_call", params: [{ to: it.to, data: it.data }, "latest"], id: id++ }));
  for (let i = 0; i < calls.length; i += BATCH_SIZE) {
    const chunk = calls.slice(i, i + BATCH_SIZE);
    const res = await rpcBatch(chunk);
    for (const c of res) {
      if (c && c.result !== undefined) results.set(c.id, c.result);
    }
    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, calls.length), calls.length);
    await sleep(300);
  }
  return { results, calls, items };
}

async function fetchTokenList() {
  try {
    const res = await fetch(TOKEN_LIST_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Object.entries(data).map(([address, t]) => ({
      symbol: t.symbol || "?",
      address,
      decimals: typeof t.decimals === "number" ? t.decimals : 18,
    }));
    return { list, source: TOKEN_LIST_URL };
  } catch (e) {
    return { list: [], source: null, error: String(e) };
  }
}

function decodeString(hex) {
  // Minimal ABI string decoder: offset(32) + length(32) + utf8 bytes.
  try {
    const b = Buffer.from(hex.slice(2), "hex");
    if (b.length < 64) return null;
    const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
    return b.subarray(64, 64 + len).toString("utf8") || null;
  } catch {
    return null;
  }
}

function decodeUint(hex) {
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

function formatAmount(raw, decimals) {
  const v = BigInt(raw);
  if (decimals === 0) return v.toString();
  const div = 10n ** BigInt(decimals);
  const whole = v / div;
  const frac = (v % div).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function revokeCalldata(spender) {
  // approve(spender, 0)
  return SEL.approve + pad32(spender) + "0".repeat(64);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const wallet = args.address;
  const spenders = [...KNOWN_SPENDERS];
  for (const a of args.extraSpenders) {
    if (!spenders.some((s) => s.address.toLowerCase() === a.toLowerCase())) {
      spenders.push({ name: "user-supplied spender", address: a });
    }
  }

  // 1. Token universe: public list + curated set (dedup by address).
  const { list: listTokens, source, error: listError } = await fetchTokenList();
  const byAddr = new Map();
  for (const t of CURATED_TOKENS) byAddr.set(t.address.toLowerCase(), { ...t });
  for (const t of listTokens) {
    const k = t.address.toLowerCase();
    if (!byAddr.has(k)) byAddr.set(k, t);
  }
  const tokens = [...byAddr.values()];
  console.error(`token universe: ${tokens.length} tokens (${listTokens.length} from 1inch list, ${CURATED_TOKENS.length} curated)${listError ? `; list fetch failed (${listError}), curated only` : ""}`);

  // 2. Pass 1: balances for every token.
  const balItems = tokens.map((t) => ({ to: t.address, data: SEL.balanceOf + pad32(wallet), key: t.address.toLowerCase() }));
  const bal = await runCalls(balItems, (done, total) => console.error(`balances: ${done}/${total}`));
  const balanceOf = new Map();
  balItems.forEach((it, idx) => {
    const raw = bal.results.get(bal.calls[idx].id);
    const v = raw ? decodeUint(raw) : null;
    balanceOf.set(it.key, v);
  });

  // 3. Pass 2: allowances vs every spender, for every token.
  const allowItems = [];
  for (const t of tokens) {
    for (const s of spenders) {
      allowItems.push({ to: t.address, data: SEL.allowance + pad32(wallet) + pad32(s.address), token: t.address.toLowerCase(), spender: s.address.toLowerCase() });
    }
  }
  const allow = await runCalls(allowItems, (done, total) => console.error(`allowances: ${done}/${total}`));
  const allowanceOf = new Map();
  allowItems.forEach((it, idx) => {
    const raw = allow.results.get(allow.calls[idx].id);
    const v = raw ? decodeUint(raw) : null;
    allowanceOf.set(`${it.token}|${it.spender}`, v);
  });

  // 4. Classify. Resolve symbol/decimals for any token with activity.
  const findings = [];
  const needMeta = new Set();
  for (const t of tokens) {
    const key = t.address.toLowerCase();
    const balV = balanceOf.get(key);
    for (const s of spenders) {
      const allowV = allowanceOf.get(`${key}|${s.address.toLowerCase()}`);
      if (allowV === null || allowV === 0n) continue;
      needMeta.add(key);
      findings.push({
        token: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        spender: s.address,
        spenderName: s.name,
        allowanceRaw: allowV.toString(),
        balanceRaw: balV === null ? null : balV.toString(),
        unlimited: allowV === MAX_UINT256,
        dust: balV !== null && balV === 0n,
        balanceUnknown: balV === null,
      });
    }
  }
  // Refresh symbol/decimals from chain for tokens whose list data is stale.
  const metaItems = [...needMeta].map((addr) => ([
    { to: addr, data: SEL.symbol, kind: "symbol", token: addr },
    { to: addr, data: SEL.decimals, kind: "decimals", token: addr },
  ])).flat();
  if (metaItems.length) {
    const meta = await runCalls(metaItems, null);
    const metaByToken = new Map();
    metaItems.forEach((it, idx) => {
      const raw = meta.results.get(meta.calls[idx].id);
      if (!raw) return;
      const m = metaByToken.get(it.token) || {};
      if (it.kind === "symbol") {
        const s = decodeString(raw);
        if (s) m.symbol = s;
      } else {
        const d = decodeUint(raw);
        if (d !== null && d <= 30n) m.decimals = Number(d);
      }
      metaByToken.set(it.token, m);
    });
    for (const f of findings) {
      const m = metaByToken.get(f.token.toLowerCase());
      if (m) {
        if (m.symbol) f.symbol = m.symbol;
        if (m.decimals !== undefined) f.decimals = m.decimals;
      }
      f.allowance = formatAmount(f.allowanceRaw, f.decimals);
      f.balance = f.balanceRaw === null ? null : formatAmount(f.balanceRaw, f.decimals);
      f.revokeCalldata = revokeCalldata(f.spender);
    }
  }

  const dust = findings.filter((f) => f.dust);
  const live = findings.filter((f) => !f.dust && !f.balanceUnknown);
  const unknown = findings.filter((f) => f.balanceUnknown);
  const report = {
    tool: "bsc-dust-approval-cleaner",
    version: "1.0.0",
    chain: { id: 56, name: "BNB Smart Chain" },
    wallet,
    scannedAt: new Date().toISOString(),
    coverage: {
      tokensChecked: tokens.length,
      spendersChecked: spenders.length,
      tokenListSource: source,
      tokenListError: listError || null,
      note: "Approvals are found by direct allowance() checks against a token universe (1inch BSC list + curated set) and a known-spender list. An approval to a spender or token outside these lists is NOT visible to this scan; a full-history scan needs an indexer or archive node.",
    },
    summary: {
      dustApprovals: dust.length,
      liveApprovals: live.length,
      unknownBalance: unknown.length,
      unlimitedApprovals: findings.filter((f) => f.unlimited).length,
    },
    dustApprovals: dust,
    liveApprovals: live,
    unknownBalanceApprovals: unknown,
  };

  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
    console.error(`report written to ${args.out}`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human-readable summary.
  console.log(`BSC Dust Approval Cleaner — ${wallet}`);
  console.log(`Scanned ${tokens.length} tokens x ${spenders.length} spenders at ${report.scannedAt}`);
  console.log(`Found ${findings.length} nonzero approval(s): ${dust.length} dust, ${live.length} live, ${unknown.length} unknown-balance.`);
  console.log("");
  if (dust.length === 0) {
    console.log("No dust approvals found in the checked set.");
    console.log("That means: for every token this wallet holds zero of, no checked");
    console.log("spender still has an allowance. It does NOT prove there are no");
    console.log("approvals at all — only that none were found in this scan's coverage.");
  } else {
    console.log("DUST APPROVALS — token balance is zero, but the spender can still");
    console.log("move tokens if any arrive later (airdrop, mistaken transfer).");
    console.log("Revoke with approve(spender, 0) — calldata shown, NOT executed.");
    console.log("");
    for (const f of dust) {
      console.log(`- ${f.symbol} (${f.token})`);
      console.log(`  spender : ${f.spenderName} (${f.spender})`);
      console.log(`  allowance: ${f.allowance} ${f.symbol}${f.unlimited ? " (UNLIMITED)" : ""}  |  balance: 0`);
      console.log(`  revoke   : ${f.revokeCalldata}`);
    }
  }
  if (live.length) {
    console.log("");
    console.log("LIVE APPROVALS (balance > 0, kept for context):");
    for (const f of live) {
      console.log(`- ${f.symbol} -> ${f.spenderName}: ${f.allowance} (balance ${f.balance})${f.unlimited ? " UNLIMITED" : ""}`);
    }
  }
  if (unknown.length) {
    console.log("");
    console.log("UNKNOWN-BALANCE approvals (balance call failed, not counted as dust):");
    for (const f of unknown) console.log(`- ${f.symbol} -> ${f.spenderName}: ${f.allowance}`);
  }
}

// Pure helpers are exported so test.mjs can verify them without a live
// scan. main() only runs when this file is executed directly.
import { pathToFileURL } from "node:url";
export { pad32, revokeCalldata, formatAmount, decodeUint, decodeString, isAddress };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`scan failed: ${e.message}`);
    process.exit(2);
  });
}
