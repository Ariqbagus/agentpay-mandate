# NOTICE

AgentPay Mandate is original code written for the Aevum Builder Challenge
(build window 16 Nov – 11 Dec 2026), MIT licensed.

Design references (no code copied verbatim; patterns re-implemented):

- **Aevum Starter Kit** — PQA Labs, MIT License
  (https://github.com/qday-io/aevum-starter-kit)
  Referenced for: the EIP-3009 `receiveWithAuthorization` funding pattern in
  `contracts/src/Checkout.sol`, the buyer-signs / relayer-submits split in
  `examples/pay-gasless`, the local mock token surface (6 decimals, EIP-712
  domain "tUSD8" version "2"), the Shanghai `evm_version` lock, the
  `--hardfork shanghai` local anvil setup, and chunked `eth_getLogs` reads
  (Aevum rejects ranges over 1,000 blocks).
  Copyright (c) 2026 PQA Labs.

- **forge-std** — Foundry contributors, MIT/Apache-2.0
  (https://github.com/foundry-rs/forge-std)
  Test and script scaffolding only (`lib/forge-std`).

- **viem** — MIT. Ethereum client library used by the agent and demo server.

Standards implemented from their public specifications: EIP-712 (typed
structured data signing), EIP-3009 (transfer with authorization), EIP-2612
(permit, in the local mock token).
