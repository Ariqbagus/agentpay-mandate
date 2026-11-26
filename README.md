# AgentPay Mandate

**An AI agent that pays tUSD8 invoices — but only inside a mandate the contract itself enforces.**

Track: **Native AI Assistants** · Aevum Builder Challenge (QDay) · all settlement on **Aevum Testnet (chain 44005)**

## The problem

Giving an AI agent a wallet key means giving it unlimited spending power: a
prompt injection, a buggy loop or a hallucinated address can drain everything.
The usual fixes (watch the agent, hope the framework behaves) put the safety
in software you have to trust. AgentPay puts it in a contract you can verify.

## How it works

```
            signs EIP-3009                signs EIP-712
 OWNER ─────────────────────► RELAYER ──► AgentMandate (contract)
   │        (gasless funding)   ▲              │  checks every rule
   │                            │              │  on-chain, then pays
 AGENT reads invoices, ─────────┘              ▼
 checks rules, signs orders                 PAYEE (tUSD8)
```

1. **The owner creates a mandate**: a total cap, a per-payment cap, a payee
   allowlist and an expiry — set once, in the `AgentMandate` contract.
2. **Funding is gasless.** The owner signs an EIP-3009
   `ReceiveWithAuthorization` off-chain; a relayer submits it and the mandate
   pulls the tUSD8 in. The owner sends no transaction and needs no gas.
3. **The agent pays invoices.** It reads invoice requests, checks each one
   against the mandate (mirrored off-chain so rejections come back with
   plain-language reasons), signs an EIP-712 `PaymentOrder`, and a relayer
   submits `executePayment`. The agent holds no funds and needs no gas.
4. **The contract is the enforcement point.** It re-checks everything —
   revoked? expired? invoice already paid? signature really from the agent?
   payee allowlisted? per-payment cap? total cap? — and only then transfers.
   Every payment emits an `InvoicePaid` event: a complete on-chain audit trail.
5. **The owner can revoke instantly.** After `revoke()`, every payment
   reverts, and unspent funds can be withdrawn.

An invoice the agent refuses is never silently dropped: it is recorded as
rejected with the exact reason ("over the per-payment cap of 40 tUSD8",
"payee is not on the allowlist", "the mandate has been revoked", …).

## Contracts

| Contract | Purpose |
|---|---|
| `src/AgentMandate.sol` | The mandate: caps, allowlist, expiry, revoke, EIP-712 agent orders, EIP-3009 gasless funding |
| `src/MockUSD8.sol` | Local-only tUSD8 stand-in (6 decimals, EIP-712 domain `tUSD8`/`2`, EIP-3009 + EIP-2612). On testnet the real tUSD8 at `0x456569838f1d43009A91ebA4263147Afd7233483` is used |

**Shanghai lock.** Aevum is EVM Shanghai only — Cancun bytecode deploys but
reverts when called. `foundry.toml` hard-locks `evm_version = "shanghai"`,
and `tools/check-shanghai.py` walks the compiled bytecode instruction by
instruction (skipping PUSH data and the CBOR metadata trailer, whose hash
bytes can look like opcodes) and fails if any Cancun opcode
(`TLOAD`/`TSTORE`/`MCOPY`/`BLOBHASH`/`BLOBBASEFEE`) is present.

## Run it locally (no login, no real funds)

Prereqs: Foundry (`forge`, `anvil`), Node 22+.

```bash
# contracts: build, test, verify the Shanghai lock
forge build
forge test                # 12 tests, see below
python3 tools/check-shanghai.py out

# local chain — MUST be the Shanghai hardfork, like Aevum
anvil --hardfork shanghai --chain-id 44005 --port 8545

# demo server + UI (separate terminal)
cd agent && npm install
node server.mjs           # http://127.0.0.1:4400
```

Open the UI: create & fund a mandate, add invoices, ask the agent to pay,
watch the over-cap and non-allowlisted invoices get rejected with reasons,
then revoke the mandate and see the agent stopped cold.

Or drive it from the CLI:

```bash
cd agent
node agent.mjs setup                       # deploy + gasless funding (demo defaults)
node agent.mjs pay-all ../invoices.example.json
node agent.mjs state
node agent.mjs revoke
```

## Test evidence (local, 26 Nov 2026)

- `forge test` — **12/12 pass**: pay within limits; over per-payment cap
  rejected; non-allowlisted payee rejected; expired mandate rejected; after
  revoke all payments rejected; total cap cannot be exceeded across payments;
  invoice cannot be paid twice; forged agent signature rejected; bad nonce
  rejected; gasless EIP-3009 funding + immediate payment; owner withdraws
  unspent funds after revoke; only the owner can revoke.
- `tools/check-shanghai.py out` — AgentMandate (4,623 bytes) and MockUSD8
  (3,279 bytes) deployed bytecode: **no Cancun opcodes**. (Cross-checked with
  `cast disassemble`; the only raw-scan "hit" sits inside the CBOR metadata
  hash, not in executable code.)
- Live local run (anvil Shanghai + demo server): mandate funded with
  100 tUSD8 via a relayed EIP-3009 authorization
  (funding tx `0xbb247c…0680d078` on the local chain); invoices of 25 and
  30 tUSD8 paid (txs `0x49b140…14e25a17`, `0x8191be…6a4379d`); a 55 tUSD8
  invoice rejected (per-payment cap 40); a payment to a non-allowlisted
  address rejected; a repeat payment of a paid invoice rejected; after
  revocation a further invoice rejected. Final on-chain state: spent 55,
  remaining 45.

## Deploy to Aevum Testnet — DONE (live 26 Nov 2026)

All steps below were executed on 26 Nov 2026; the mandate is live on Aevum
Testnet with real tUSD8. The process is kept here as the runbook.

1. **Claim faucet funds** (owner only): join the QDay Discord, verify
   (✅ in `#verify`), then `/faucet <deployer-address>` in `#faucet` →
   1 tQDAY + 5 tUSD8. (The web faucet rejects wallets with no mainnet
   balance, so Discord is the reliable path.)
2. **Set env** (see `.env.example`): `MODE=testnet`, `OWNER_KEY` (deployer),
   `AGENT_KEY`, `RELAYER_KEY`; give the relayer a little tQDAY for gas.
   Never commit keys.
3. **Deploy the mandate** against the real tUSD8 (legacy txs — Aevum uses
   type-0):
   ```bash
   DEPLOYER_KEY=0x… AGENT_ADDRESS=0x… PAYEES=0x…,0x… \
   forge script script/DeployTestnet.s.sol \
     --rpc-url https://rpc-test.qday.info --broadcast --legacy
   ```
   Defaults: total cap 5 tUSD8 (the faucet amount), per-payment cap 2, 30-day
   expiry — override with `TOTAL_CAP` / `PER_PAYMENT_CAP` / `EXPIRY_DAYS`.
4. **Fund the mandate** from the owner wallet: either `approve` + `fund`, or
   the gasless path — set `MANDATE_ADDRESS` from step 3 in `agent/data` via
   the server setup in testnet mode, which funds by relayed EIP-3009
   authorization exactly as in the local demo.
5. **Run the agent + UI** against testnet (`MODE=testnet node server.mjs`),
   pay a real invoice, and record below: contract address + explorer link,
   the exact commit deployed, and the payment tx hashes. (Explorer contract
   verification is broken on the organizer side; per the official docs the
   address + commit link are the substitute proof.)

| Item | Value |
|---|---|
| AgentMandate (Aevum Testnet) | [0xc1f2E27847Ac51B71AD638756bFBa0b77Ce2C8Ea](https://explorer-test.qday.info/address/0xc1f2E27847Ac51B71AD638756bFBa0b77Ce2C8Ea) |
| Deploy tx | [0x28a0a0d26b56d5a03b0d2b6a7a40be5a4a6b5a6d2da8021f1a5c56d40ee2a54b](https://explorer-test.qday.info/tx/0x28a0a0d26b56d5a03b0d2b6a7a40be5a4a6b5a6d2da8021f1a5c56d40ee2a54b) |
| Funding tx | [0x454b0034940b14773898dc16023f9c80d195f32064da2409977c7d7ccd87b98e](https://explorer-test.qday.info/tx/0x454b0034940b14773898dc16023f9c80d195f32064da2409977c7d7ccd87b98e) — 5 tUSD8, gasless EIP-3009: owner signed off-chain, relayer submitted |
| Sample payment tx(s) | [0xfc7b06dc2e1996a3a83df0b760d2b4d108b30795daa9b25525929ffa9fddfade](https://explorer-test.qday.info/tx/0xfc7b06dc2e1996a3a83df0b760d2b4d108b30795daa9b25525929ffa9fddfade) — 1.5 tUSD8 to `0x90F79bf6EB2c4f870365E785982E1f101E93b906`, `InvoicePaid` event on-chain |
| Deployed commit | `9fcf7096e0559124d00195e4239947acacebf5af` (GitHub repo commit of this code; the local working copy is not a git checkout) |

**Live testnet evidence (26 Nov 2026), all read back from the chain:**

- Mandate parameters verified on-chain: owner
  `0x659e41A546848Dd3F9930ea5Cbd31467991DcBFd`, agent
  `0x2C92933d83f2D2B1B897127902b167596c75a364`, total cap 5 tUSD8,
  per-payment cap 2 tUSD8, expiry 2026-12-26 05:43 UTC (30 days), both demo
  payees allowlisted, `isActive() = true`, `revoked() = false`.
- Funding: the full 5 tUSD8 faucet amount was pulled into the mandate by a
  relayed EIP-3009 authorization (funding tx above); the owner wallet sent no
  funding transaction and its tUSD8 balance is 0 afterwards.
- Payment: invoice INV-T001 of 1.5 tUSD8 was paid by a relayed,
  agent-signed EIP-712 order (payment tx above; Transfer + InvoicePaid logs
  verified in the receipt). Mandate state afterwards: spent 1.5, remaining
  3.5, agent nonce 1.
- Rejection: a validly signed order for 3 tUSD8 (invoice INV-T002, over the
  2 tUSD8 per-payment cap) reverts on-chain with `OverPerPaymentCap`
  (verified by `eth_call` simulation against the live contract); the agent
  records it as rejected with that plain-language reason.

## Layout

```
src/            AgentMandate.sol, MockUSD8.sol (local only), IERC3009.sol
test/           Foundry tests for every mandate rule
script/         DeployLocal.s.sol (anvil demo), DeployTestnet.s.sol (Aevum)
agent/          lib.mjs (agent + relayer core), agent.mjs (CLI), server.mjs (demo API)
ui/             dependency-free demo UI served by server.mjs
tools/          check-shanghai.py — Cancun-opcode scanner
invoices.example.json   demo invoice batch (2 pay, 2 rejected, by design)
```

## Credits

Built on patterns from the official **Aevum Starter Kit** by PQA Labs (MIT):
the `Checkout` contract's EIP-3009 `payWithAuthorization` flow and the
`examples/pay-gasless` signer/relayer split were the reference for the
gasless funding leg and the relayed execution model. The mandate contract,
agent, and UI in this repo are original code written for this challenge.
See `NOTICE.md`.
