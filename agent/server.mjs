/**
 * AgentPay Mandate — local demo server.
 * Serves the UI (../ui) and a small JSON API over the agent core (lib.mjs).
 * No login: it runs against a local anvil with demo wallets. For testnet,
 * run with MODE=testnet and the env keys set (see ../.env.example).
 *
 *   node server.mjs            # http://127.0.0.1:4400
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setup, readMandate, loadInvoices, createInvoice, payInvoice, revoke, addPayee, MODE, RPC_URL } from "./lib.mjs";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const PORT = Number(process.env.PORT ?? 4400);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body));
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const routes = {
  "GET /api/state": async () => ({ mode: MODE, rpc: RPC_URL, mandate: await readMandate(), invoices: loadInvoices() }),
  "POST /api/setup": async (req) => {
    const b = await bodyJson(req);
    const state = await setup({
      totalCap: String(b.totalCap ?? "100"),
      perPaymentCap: String(b.perPaymentCap ?? "40"),
      expiryHours: Number(b.expiryHours ?? 24 * 7),
      fundAmount: String(b.fundAmount ?? b.totalCap ?? "100"),
      payees: b.payees ?? [],
    });
    return { ok: true, state };
  },
  "POST /api/invoices": async (req) => ({ ok: true, invoice: createInvoice(await bodyJson(req)) }),
  "POST /api/revoke": async () => ({ ok: true, txHash: await revoke() }),
  "POST /api/payees": async (req) => {
    const b = await bodyJson(req);
    return { ok: true, txHash: await addPayee(b.address) };
  },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const payMatch = url.pathname.match(/^\/api\/invoices\/([\w-]+)\/pay$/);
    if (req.method === "POST" && payMatch) {
      return send(res, 200, { ok: true, invoice: await payInvoice(payMatch[1]) });
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(req));
    if (req.method === "GET") {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(UI, path);
      if (!file.startsWith(UI)) return send(res, 403, "forbidden", "text/plain");
      return send(res, 200, await readFile(file), MIME[extname(file)] ?? "application/octet-stream");
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 400, { error: String(err.message ?? err).split("\n")[0] });
  }
});

server.listen(PORT, () => console.log(`AgentPay demo (${MODE}) at http://127.0.0.1:${PORT} via ${RPC_URL}`));
