# BSC Dust Approval Cleaner

A read-only CLI agent that finds **dust approvals**: ERC-20 allowances a BSC
wallet no longer needs because the token balance is zero — but the spender
can still move tokens if any ever arrive.

## The problem

`approve()` is sticky. Once you approve a spender, the allowance stays until
it is spent or revoked — even after your balance of that token drops to zero.
Wallets and dashboards only show approvals for tokens you currently hold, so
these dust approvals are invisible. And a zero balance today is not zero
risk: tokens can arrive later via an airdrop, a mistaken transfer, or a dust
attack — and the old approval is already in place, ready to move the new
balance before you get a chance to revoke it. Approvals are often unlimited,
so the exposure is the entire future balance.

See [DESIGN.md](DESIGN.md) for the full threat model and the design choices.

## What it does

Given a wallet address, it scans **462 tokens × 5 spenders** on BNB Smart
Chain (chain 56) and reports:

- **Dust approvals** — allowance > 0, balance = 0. Each comes with the exact
  `approve(spender, 0)` calldata needed to revoke it.
- **Live approvals** — allowance > 0, balance > 0 (context, not a problem).
- **Unknown-balance approvals** — the balance call failed, so the tool
  refuses to classify them as dust rather than guessing.

It never signs, never sends a transaction, and never asks for a private key.
It only reads public chain state (`balanceOf`, `allowance`, `symbol`,
`decimals`) through public BSC RPC endpoints. The worst thing a bug in this
tool can do is print a wrong report.

## How to run

Requires Node.js 18+ (uses only the standard library — no dependencies, no
install step).

```sh
node cleaner.mjs <wallet-address> [--json] [--out <file>] [--spenders addr1,addr2]
```

Examples:

```sh
# Human-readable summary
node cleaner.mjs 0x2259faa64d3B97D1d6889CaeAC719e4C64c23e98

# Machine-readable JSON report, saved to a file
node cleaner.mjs 0x2259faa64d3B97D1d6889CaeAC719e4C64c23e98 --json --out report.json

# Also check extra spenders beyond the built-in list
node cleaner.mjs 0x2259faa64d3B97D1d6889CaeAC719e4C64c23e98 --spenders 0x1234...,0x5678...
```

A full scan takes ~3 minutes (about 2,300 `eth_call`s in small batches
against rotating public RPC endpoints). Progress is printed to stderr; the
report goes to stdout (or `--out`).

## Sample run

`sample-report.json` is a real run against the account's EOA
(`0x2259faa64d3B97D1d6889CaeAC719e4C64c23e98`), 15 Nov 2026:

```text
BSC Dust Approval Cleaner — 0x2259faa64d3b97d1d6889caeac719e4c64c23e98
Scanned 462 tokens x 5 spenders at 2026-11-15T00:00:44.626Z
Found 0 nonzero approval(s): 0 dust, 0 live, 0 unknown-balance.

No dust approvals found in the checked set.
```

A second real run against a different wallet is in
`sample-report-agentic.json` (also 0 dust approvals in the checked set).
Both wallets are clean inside this scan's coverage — which is a legitimate
result, not a failure: the tool reports what it found, and a clean wallet
has nothing to revoke. When dust approvals exist, each one is listed with
its token, spender, allowance, and revoke calldata.

## How it finds approvals

There is no on-chain registry of "all approvals for wallet X". The tool
checks `allowance()` directly for a token universe × spender list:

- **Token universe:** the public 1inch BSC token list (~460 tokens) plus a
  curated set of well-known BSC tokens (A404, G404, USDT, BUSD, WBNB, CAKE,
  USDC, BTCB, ETH, DW). If the list fetch fails, it falls back to the
  curated set and says so in the report.
- **Spender list:** PancakeSwap V2/V3 routers, the Agent404 PASSDROP and
  AGENTS MINE engines, and the Agent ID registry — plus any extra spenders
  passed with `--spenders`.

`eth_getLogs` (a full-history `Approval` event scan) would be more complete,
but public BSC RPC endpoints rate-limit or reject log queries from this
environment, so the tool does not depend on them. Every report carries a
`coverage` block stating exactly what was checked.

## What it cannot do

- Find approvals for tokens or spenders outside its lists. A complete audit
  needs an indexer (BscScan API, archive node, or a self-hosted log scan).
- Find ERC-721 / ERC-1155 approvals (`setApprovalForAll`) — a different
  mechanism, a separate tool.
- Judge whether an approval is malicious. It reports that the allowance
  exists and the balance is zero; a router you still use is fine to keep,
  an unknown contract is not.
- Revoke anything itself. That is deliberate: revoking needs your wallet,
  where you can see what you are signing.

## Files

| File | What it is |
| --- | --- |
| `cleaner.mjs` | The agent (Node.js, stdlib only) |
| `test.mjs` | Self-test for the pure helpers (calldata, formatting) — `node test.mjs` |
| `sample-report.json` | Real run: account EOA, 462 tokens × 5 spenders, 0 dust |
| `sample-report-agentic.json` | Real run: second wallet, same coverage, 0 dust |
| `DESIGN.md` | Threat model, why read-only, coverage limits, zkVerify future work |
| `LICENSE` | MIT |

## Future work

An audit report is only as trustworthy as whoever ran it. A zkVerify proof
could make "I checked and found N dust approvals" checkable: a Groth16
proof that the scan followed a fixed rule (same token list, same spender
list, same block height) and produced the reported result, verifiable
against zkVerify's registered key without re-running the scan. The scan
rule is deterministic, which is exactly what a proof needs — but building
the circuit is a project in itself, so it is named as the next step in
[DESIGN.md](DESIGN.md), not claimed as done.

## License

MIT — see [LICENSE](LICENSE).
