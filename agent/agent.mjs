/**
 * AgentPay agent — command line runner.
 *
 *   node agent.mjs setup                 deploy + fund the mandate (demo defaults)
 *   node agent.mjs pay-all <file.json>   evaluate and pay every invoice in a file
 *   node agent.mjs pay INV-001           pay one stored invoice
 *   node agent.mjs state                 print the mandate state
 *   node agent.mjs revoke                owner revokes the mandate
 *
 * Invoice file format: [{ "payee": "0x...", "amount": "12.50", "memo": "..." }]
 * Every invoice ends up paid (with a tx hash) or rejected (with a
 * plain-language reason). Nothing is silently skipped.
 */
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { setup, readMandate, createInvoice, loadInvoices, payInvoice, revoke, MODE } from "./lib.mjs";

const [cmd, arg] = process.argv.slice(2);

if (cmd === "setup") {
  const state = await setup({
    totalCap: process.env.TOTAL_CAP ?? "100",
    perPaymentCap: process.env.PER_PAYMENT_CAP ?? "40",
    expiryHours: Number(process.env.EXPIRY_HOURS ?? 24 * 7),
    fundAmount: process.env.FUND_AMOUNT ?? process.env.TOTAL_CAP ?? "100",
    payees: (process.env.PAYEES ?? "0x90F79bf6EB2c4f870365E785982E1f101E93b906,0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65").split(","),
  });
  console.log(JSON.stringify(state, null, 2));
} else if (cmd === "pay-all") {
  if (!arg) throw new Error("usage: node agent.mjs pay-all <invoices.json>");
  const wanted = JSON.parse(readFileSync(arg, "utf8"));
  const known = loadInvoices();
  for (const item of wanted) {
    const existing = known.find(
      (i) => i.payee.toLowerCase() === item.payee.toLowerCase() && i.amount === String(item.amount) && i.memo === (item.memo ?? ""),
    );
    const invoice = existing ?? createInvoice(item);
    invoice.invoiceIdBytes ??= keccak256(toHex(invoice.id));
    const result = await payInvoice(invoice.id);
    console.log(
      result.status === "paid"
        ? `PAID     ${result.id}  ${result.amount} tUSD8 -> ${result.payee}  tx ${result.txHash}`
        : `REJECTED ${result.id}  ${result.amount} tUSD8 -> ${result.payee}  ${result.reason}`,
    );
  }
} else if (cmd === "pay") {
  const result = await payInvoice(arg);
  console.log(JSON.stringify(result, null, 2));
} else if (cmd === "state") {
  console.log(JSON.stringify(await readMandate(), null, 2));
} else if (cmd === "revoke") {
  console.log(`revoked in tx ${await revoke()}`);
} else {
  console.log(`AgentPay agent (${MODE} mode). Commands: setup | pay-all <file> | pay <id> | state | revoke`);
}
