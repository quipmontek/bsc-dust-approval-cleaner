# Design note — BSC Dust Approval Cleaner

## The problem

ERC-20 `approve()` is sticky. Once a wallet approves a spender, the
allowance stays until it is spent or revoked — even after the wallet's
balance of that token drops to zero. Most wallets and dashboards only show
approvals for tokens you currently hold, so these "dust approvals" are
invisible: a token you no longer hold, with a live allowance to a contract
you may not remember approving.

## Why a zero balance is not zero risk

Tokens can arrive in a wallet at any time, without the owner doing
anything:

- **Airdrops.** Projects airdrop to past holders and past users. A wallet
  that once held a token is a likely airdrop target for it.
- **Mistaken transfers.** Someone sends tokens to the wrong address, or a
  refund lands in an old wallet.
- **Dust attacks.** Small amounts are sent deliberately to track wallets.

The moment tokens arrive, the old approval is already in place. The
spender can move the new balance in the same block it lands — the owner
never gets a chance to revoke first. The risk is small per token, but the
allowance is often unlimited (`2^256 - 1`), so the exposure is the entire
future balance, not a capped amount.

This is not hypothetical hygiene theater: approval phishing is one of the
most common ways wallets are drained, and the standard advice ("revoke
approvals you don't use") is hard to follow because nobody can see the
approvals for tokens they no longer hold. That gap is what this tool
closes.

## Why read-only is the right call

A cleaner that revokes on your behalf would need a private key or a wallet
signature, which turns a safety tool into a new attack surface: a bug or a
compromised build could revoke the wrong thing, or sign something else
entirely. So this agent does the minimum useful thing and stops there:

1. It reads chain state only (`balanceOf`, `allowance`, `symbol`,
   `decimals` via `eth_call`).
2. It reports what it found, with the exact `approve(spender, 0)`
   calldata for each dust approval.
3. The user reviews the list and revokes through their own wallet, where
   they can see what they are signing.

No key, no signature, no transaction, no state change. The worst thing a
bug in this tool can do is print a wrong report.

## How it finds approvals (and what it cannot see)

There is no on-chain registry of "all approvals for wallet X". The honest
ways to find them are:

- **Scan `Approval` events** (`eth_getLogs`) over the wallet's whole
  history. This is complete, but public BSC RPC endpoints rate-limit or
  reject log queries from this environment, so it is not reliable here.
- **Check `allowance()` directly** for a token universe × spender list.
  This is what the tool does: it takes a public token list (1inch BSC
  list, ~460 tokens) plus a curated set of well-known tokens, and checks
  each against a list of known spenders (DEX routers, project engines).
  It is deterministic and fast, and it finds every approval inside that
  universe.

The limitation is stated in every report: an approval to a spender or a
token outside the checked lists is invisible to this scan. A complete
audit needs an indexer (BscScan API, archive node, or a self-hosted log
scan). The tool's `coverage` block says exactly what was checked, so a
clean result is never presented as a proof of "no approvals".

## What it cannot do

- It cannot find approvals for tokens or spenders outside its lists.
- It cannot find ERC-721 / ERC-1155 approvals (`setApprovalForAll`) —
  those are a different mechanism and a separate tool.
- It cannot tell whether an approval is malicious; it can only say the
  allowance exists and the balance is zero. A router you still use is
  fine to keep; an unknown contract is not.
- It cannot revoke anything itself. That is deliberate.

## Future work: making an audit checkable with zkVerify

An audit report is only as trustworthy as the person who ran it. A
zkVerify proof could turn "I checked and found N dust approvals" into a
checkable claim: the agent would generate a Groth16 proof that its scan
followed a fixed rule (same token list, same spender list, same block
height) and produced the reported result, and anyone could verify the
proof against zkVerify's registered key without re-running the scan or
trusting the agent.

That is future work, not implemented here. The honest reason: proving a
scan over hundreds of `eth_call` results requires a circuit that encodes
the RPC responses as public inputs, and the tooling for that (a circuit
over the scan rule, plus a way to anchor the block height) is a project
in itself. The design is sound — the scan rule is deterministic, which is
exactly what a proof needs — but shipping a half-baked proof would be
worse than shipping none. The Wildcard submission therefore claims only
what the tool does today, and names the proof as the next step.
