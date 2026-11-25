/**
 * AgentPay Mandate — agent + relayer core library.
 *
 * The pattern, end to end:
 *   1. OWNER funds the AgentMandate contract. Funding itself is gasless:
 *      the owner signs an EIP-3009 ReceiveWithAuthorization off-chain and a
 *      RELAYER submits it (the owner sends no transaction).
 *   2. AGENT reads invoices, checks each one against the mandate rules
 *      (mirrored off-chain so rejections get plain-language reasons), signs
 *      an EIP-712 PaymentOrder, and hands it to the relayer.
 *   3. RELAYER submits executePayment. The contract re-checks every rule
 *      on-chain; the agent's signature is the only authority it needs.
 *
 * The agent never holds funds and never needs gas. The contract is the
 * enforcement point; this file is only the operator.
 *
 * Modes:
 *   local   (default) anvil --hardfork shanghai --chain-id 44005; a mock
 *           tUSD8 is deployed and demo wallets are generated under data/.
 *   testnet Aevum Testnet (chain 44005, https://rpc-test.qday.info) with the
 *           real tUSD8. Keys and addresses come from the environment.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  formatUnits,
  keccak256,
  toHex,
  parseSignature,
  hashTypedData,
  getAddress,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import contracts from "./contracts.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
mkdirSync(DATA, { recursive: true });

export const MODE = process.env.MODE ?? "local";
export const RPC_URL = process.env.RPC_URL ?? (MODE === "testnet" ? "https://rpc-test.qday.info" : "http://127.0.0.1:8545");
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 44005);
export const REAL_TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
// Anvil account #0. A public, well-known LOCAL DEV key; only used to seed
// demo wallets with test ETH on a local anvil. Never a real wallet.
const LOCAL_FUNDER_KEY = process.env.LOCAL_FUNDER_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const chain = defineChain({
  id: CHAIN_ID,
  name: MODE === "testnet" ? "Aevum Testnet" : "Aevum Local (anvil, Shanghai)",
  nativeCurrency: { name: "QDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
});

export const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const walletFor = (account) => createWalletClient({ account, chain, transport: http(RPC_URL) });

// ------------------------------------------------------------ key handling

function loadOrCreateKeys() {
  const file = join(DATA, "keys.json");
  if (MODE === "testnet") {
    const need = (name) => {
      const v = process.env[name];
      if (!v) throw new Error(`${name} is required in testnet mode`);
      return v;
    };
    return {
      owner: privateKeyToAccount(need("OWNER_KEY")),
      agent: privateKeyToAccount(need("AGENT_KEY")),
      relayer: privateKeyToAccount(need("RELAYER_KEY")),
    };
  }
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      owner: privateKeyToAccount(raw.owner),
      agent: privateKeyToAccount(raw.agent),
      relayer: privateKeyToAccount(raw.relayer),
    };
  }
  const raw = { owner: generatePrivateKey(), agent: generatePrivateKey(), relayer: generatePrivateKey() };
  writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
  return {
    owner: privateKeyToAccount(raw.owner),
    agent: privateKeyToAccount(raw.agent),
    relayer: privateKeyToAccount(raw.relayer),
  };
}

export const keys = loadOrCreateKeys();
export const ownerWallet = walletFor(keys.owner);
export const agentWallet = walletFor(keys.agent);
export const relayerWallet = walletFor(keys.relayer);

// ------------------------------------------------------------------- state

const stateFile = join(DATA, "state.json");
const invoicesFile = join(DATA, "invoices.json");

export function loadState() {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
}
function saveState(state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
export function loadInvoices() {
  return existsSync(invoicesFile) ? JSON.parse(readFileSync(invoicesFile, "utf8")) : [];
}
function saveInvoices(list) {
  writeFileSync(invoicesFile, JSON.stringify(list, null, 2));
}

const mandateAbi = contracts.AgentMandate.abi;
const tokenAbi = contracts.MockUSD8.abi; // same ERC-20/EIP-3009 surface as real tUSD8

async function legacyWrite(wallet, params) {
  const hash = await wallet.writeContract({ ...params, type: "legacy" });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return { hash, receipt };
}

// ------------------------------------------------------------------- setup

/** Deploy (local: mock token + mandate; testnet: mandate only) and fund the
 *  mandate gaslessly via a signed EIP-3009 authorization relayed by the relayer. */
export async function setup({ totalCap, perPaymentCap, expiryHours, payees, fundAmount }) {
  const state = { mode: MODE, chainId: CHAIN_ID, rpc: RPC_URL, owner: keys.owner.address, agent: keys.agent.address, relayer: keys.relayer.address };

  if (MODE === "local") {
    const funder = walletFor(privateKeyToAccount(LOCAL_FUNDER_KEY));
    for (const account of [keys.owner, keys.agent, keys.relayer]) {
      const bal = await pub.getBalance({ address: account.address });
      if (bal < parseUnits("0.2", 18)) {
        const hash = await funder.sendTransaction({ to: account.address, value: parseUnits("0.5", 18), type: "legacy" });
        await pub.waitForTransactionReceipt({ hash });
      }
    }
    const tokenHash = await ownerWallet.deployContract({ abi: tokenAbi, bytecode: contracts.MockUSD8.bytecode, type: "legacy" });
    const tokenReceipt = await pub.waitForTransactionReceipt({ hash: tokenHash });
    state.token = tokenReceipt.contractAddress;
    await legacyWrite(ownerWallet, { address: state.token, abi: tokenAbi, functionName: "mint", args: [keys.owner.address, parseUnits("1000", 6)] });
  } else {
    state.token = getAddress(process.env.TOKEN_ADDRESS ?? REAL_TUSD8);
  }

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(expiryHours * 3600));
  const deployHash = await ownerWallet.deployContract({
    abi: mandateAbi,
    bytecode: contracts.AgentMandate.bytecode,
    args: [state.token, keys.agent.address, parseUnits(totalCap, 6), parseUnits(perPaymentCap, 6), expiresAt, payees],
    type: "legacy",
  });
  const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash });
  state.mandate = deployReceipt.contractAddress;
  state.deployTx = deployHash;
  state.params = { totalCap, perPaymentCap, fundAmount, expiresAt: Number(expiresAt), payees };

  // Gasless funding: owner signs EIP-3009, relayer submits.
  const value = parseUnits(fundAmount, 6);
  const now = Math.floor(Date.now() / 1000);
  const nonce = keccak256(toHex(`agentpay-funding-${state.mandate}-${now}`));
  const signature = await keys.owner.signTypedData({
    domain: { name: "tUSD8", version: "2", chainId: CHAIN_ID, verifyingContract: state.token },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: keys.owner.address, to: state.mandate, value, validAfter: BigInt(now - 60), validBefore: BigInt(now + 3600), nonce },
  });
  const { v, r, s } = parseSignature(signature);
  const { hash: fundingTx } = await legacyWrite(relayerWallet, {
    address: state.mandate,
    abi: mandateAbi,
    functionName: "fundWithAuthorization",
    args: [keys.owner.address, value, BigInt(now - 60), BigInt(now + 3600), nonce, Number(v ?? 27), r, s],
  });
  state.fundingTx = fundingTx;
  saveState(state);
  return state;
}

// --------------------------------------------------------------- chain reads

async function getLogsChunked(address, event, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += 900n) {
    const end = start + 899n > toBlock ? toBlock : start + 899n;
    logs.push(...(await pub.getLogs({ address, event, fromBlock: start, toBlock: end })));
  }
  return logs;
}

const invoicePaidEvent = mandateAbi.find((x) => x.type === "event" && x.name === "InvoicePaid");

export async function readMandate() {
  const state = loadState();
  if (!state?.mandate) return null;
  const m = state.mandate;
  const read = (functionName, args = []) => pub.readContract({ address: m, abi: mandateAbi, functionName, args });
  const [totalCap, perPaymentCap, spent, expiresAt, revoked, active, remaining, balance, agentNonce] = await Promise.all([
    read("totalCap"), read("perPaymentCap"), read("spent"), read("expiresAt"), read("revoked"),
    read("isActive"), read("remaining"),
    pub.readContract({ address: state.token, abi: tokenAbi, functionName: "balanceOf", args: [m] }),
    read("agentNonce"),
  ]);
  const latest = await pub.getBlockNumber();
  const logs = await getLogsChunked(m, invoicePaidEvent, 0n, latest);
  const payments = logs.map((log) => ({
    invoiceId: log.args.invoiceId,
    payee: log.args.payee,
    amount: formatUnits(log.args.amount, 6),
    totalSpent: formatUnits(log.args.totalSpent, 6),
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
  }));
  const payees = [];
  for (const p of state.params.payees) {
    if (await read("isPayee", [p])) payees.push(p);
  }
  return {
    ...state,
    onchain: {
      totalCap: formatUnits(totalCap, 6),
      perPaymentCap: formatUnits(perPaymentCap, 6),
      spent: formatUnits(spent, 6),
      remaining: formatUnits(remaining, 6),
      balance: formatUnits(balance, 6),
      expiresAt: Number(expiresAt),
      revoked,
      active,
      agentNonce: Number(agentNonce),
    },
    payees,
    payments,
  };
}

// ----------------------------------------------------------------- invoices

export function createInvoice({ payee, amount, memo }) {
  const list = loadInvoices();
  const id = `INV-${String(list.length + 1).padStart(3, "0")}`;
  const invoice = {
    id,
    invoiceIdBytes: keccak256(toHex(id)),
    payee: getAddress(payee),
    amount: String(amount),
    memo: memo ?? "",
    status: "pending",
    reason: null,
    txHash: null,
    createdAt: new Date().toISOString(),
  };
  list.push(invoice);
  saveInvoices(list);
  return invoice;
}

/** Mirror of the contract's checks, in the same order, with plain-language
 *  reasons. The contract re-checks everything on-chain regardless. */
export function evaluate(invoice, view) {
  const fail = (reason) => ({ ok: false, reason });
  const o = view.onchain;
  if (o.revoked) return fail("The mandate has been revoked by its owner, so the agent can no longer pay anything.");
  if (!o.active) return fail("The mandate has expired, so the agent can no longer pay.");
  const amount = Number(invoice.amount);
  if (!(amount > 0)) return fail("The invoice amount must be more than zero.");
  const already = view.payments.some((p) => p.invoiceId.toLowerCase() === invoice.invoiceIdBytes.toLowerCase());
  if (already || invoice.status === "paid") return fail("This invoice has already been paid. Each invoice can only be paid once.");
  if (!view.payees.some((p) => p.toLowerCase() === invoice.payee.toLowerCase()))
    return fail(`Payee ${invoice.payee} is not on the mandate's allowlist. The owner must add them before the agent can pay.`);
  if (amount > Number(o.perPaymentCap))
    return fail(`This invoice is ${invoice.amount} tUSD8, over the per-payment cap of ${o.perPaymentCap} tUSD8 set in the mandate.`);
  if (Number(o.spent) + amount > Number(o.totalCap))
    return fail(`Paying ${invoice.amount} tUSD8 would exceed the mandate's total cap of ${o.totalCap} tUSD8 (already spent: ${o.spent}).`);
  const balance = Number(o.balance);
  if (amount > balance) return fail(`The mandate only holds ${o.balance} tUSD8 right now, less than this invoice.`);
  return { ok: true };
}

export async function payInvoice(id) {
  const list = loadInvoices();
  const invoice = list.find((i) => i.id === id);
  if (!invoice) throw new Error(`unknown invoice ${id}`);
  const view = await readMandate();
  if (!view) throw new Error("no mandate yet: run setup first");

  const verdict = evaluate(invoice, view);
  invoice.checkedAt = new Date().toISOString();
  if (!verdict.ok) {
    invoice.status = "rejected";
    invoice.reason = verdict.reason;
    saveInvoices(list);
    return invoice;
  }

  const order = {
    invoiceId: invoice.invoiceIdBytes,
    payee: invoice.payee,
    amount: parseUnits(invoice.amount, 6),
    nonce: BigInt(view.onchain.agentNonce),
  };
  const domain = { name: "AgentPay Mandate", version: "1", chainId: CHAIN_ID, verifyingContract: view.mandate };
  const types = {
    PaymentOrder: [
      { name: "invoiceId", type: "bytes32" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  // Cross-check viem's digest against the contract's own digest function.
  const onchainDigest = await pub.readContract({ address: view.mandate, abi: mandateAbi, functionName: "paymentOrderDigest", args: [order] });
  const localDigest = hashTypedData({ domain, types, primaryType: "PaymentOrder", message: order });
  if (onchainDigest.toLowerCase() !== localDigest.toLowerCase()) throw new Error("EIP-712 digest mismatch between agent and contract");

  const signature = await keys.agent.signTypedData({ domain, types, primaryType: "PaymentOrder", message: order });
  const { v, r, s } = parseSignature(signature);
  try {
    const { hash } = await legacyWrite(relayerWallet, {
      address: view.mandate,
      abi: mandateAbi,
      functionName: "executePayment",
      args: [order, Number(v ?? 27), r, s],
    });
    invoice.status = "paid";
    invoice.txHash = hash;
    invoice.reason = null;
  } catch (err) {
    invoice.status = "rejected";
    invoice.reason = `The mandate contract rejected this payment on-chain: ${String(err.message ?? err).split("\n")[0]}`;
  }
  saveInvoices(list);
  return invoice;
}

// ------------------------------------------------------------------- admin

export async function revoke() {
  const state = loadState();
  if (!state?.mandate) throw new Error("no mandate yet");
  const { hash } = await legacyWrite(ownerWallet, { address: state.mandate, abi: mandateAbi, functionName: "revoke", args: [] });
  return hash;
}

export async function addPayee(address) {
  const state = loadState();
  if (!state?.mandate) throw new Error("no mandate yet");
  const payee = getAddress(address);
  const { hash } = await legacyWrite(ownerWallet, { address: state.mandate, abi: mandateAbi, functionName: "setPayee", args: [payee, true] });
  if (!state.params.payees.some((p) => p.toLowerCase() === payee.toLowerCase())) {
    state.params.payees.push(payee);
    saveState(state);
  }
  return hash;
}
