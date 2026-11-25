const $ = (id) => document.getElementById(id);
const short = (a) => (a && a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

function toast(msg, ms = 4200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), ms);
}

async function refresh() {
  const { mode, mandate, invoices } = await api("/api/state");
  $("conn").textContent = mandate
    ? `mode: ${mode} · token ${short(mandate.token)} · owner ${short(mandate.owner)} · relayer ${short(mandate.relayer)}`
    : `mode: ${mode} · no mandate yet`;

  $("setup-card").classList.toggle("hidden", !!mandate);
  for (const id of ["mandate-card", "invoice-card", "audit-card"]) $(id).classList.toggle("hidden", !mandate);
  if (!mandate) return;

  const o = mandate.onchain;
  const status = $("m-status");
  status.textContent = o.revoked ? "REVOKED" : o.active ? "ACTIVE" : "EXPIRED";
  status.classList.toggle("off", !o.active);
  $("m-address").textContent = mandate.mandate;
  $("m-agent").textContent = mandate.agent;
  $("m-total").textContent = `${o.totalCap} tUSD8`;
  $("m-perpay").textContent = `${o.perPaymentCap} tUSD8`;
  $("m-spent").textContent = `${o.spent} tUSD8`;
  $("m-remaining").textContent = `${o.remaining} tUSD8`;
  $("m-balance").textContent = `${o.balance} tUSD8`;
  $("m-expiry").textContent = new Date(o.expiresAt * 1000).toLocaleString();
  $("m-bar").style.width = `${Math.min(100, (Number(o.spent) / Number(o.totalCap)) * 100)}%`;
  $("m-payees").textContent = mandate.payees.join(", ") || "(none)";
  $("revoke-btn").disabled = o.revoked;

  $("invoice-rows").innerHTML = invoices
    .map((i) => {
      const statusCell =
        i.status === "paid"
          ? `<span class="status-paid">paid</span><span class="reason mono">tx ${short(i.txHash)}</span>`
          : i.status === "rejected"
            ? `<span class="status-rejected">rejected</span><span class="reason">${i.reason ?? ""}</span>`
            : `<span>pending</span>`;
      const action = i.status === "pending" ? `<button class="small" data-pay="${i.id}">Ask agent to pay</button>` : "";
      return `<tr><td>${i.id}</td><td class="mono">${short(i.payee)}</td><td>${i.amount}</td><td>${i.memo ?? ""}</td><td>${statusCell}</td><td>${action}</td></tr>`;
    })
    .join("");
  for (const btn of document.querySelectorAll("[data-pay]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const { invoice } = await api(`/api/invoices/${btn.dataset.pay}/pay`, {});
        toast(invoice.status === "paid" ? `${invoice.id} paid: ${invoice.txHash}` : `${invoice.id} rejected: ${invoice.reason}`, 7000);
      } catch (e) {
        toast(`Error: ${e.message}`);
      }
      refresh();
    });
  }

  $("payment-rows").innerHTML = mandate.payments
    .map((p) => `<tr><td class="mono">${short(p.invoiceId)}</td><td class="mono">${short(p.payee)}</td><td>${p.amount} tUSD8</td><td class="mono">${short(p.txHash)}</td></tr>`)
    .join("");
}

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("/api/setup", {
      totalCap: f.get("totalCap"),
      perPaymentCap: f.get("perPaymentCap"),
      fundAmount: f.get("fundAmount"),
      expiryHours: Number(f.get("expiryHours")),
      payees: String(f.get("payees")).split("\n").map((s) => s.trim()).filter(Boolean),
    });
    toast("Mandate created and funded (gasless, via a relayed EIP-3009 authorization).");
  } catch (err) {
    toast(`Setup failed: ${err.message}`);
  }
  refresh();
});

$("invoice-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("/api/invoices", { payee: f.get("payee"), amount: f.get("amount"), memo: f.get("memo") });
    e.target.reset();
  } catch (err) {
    toast(`Could not add invoice: ${err.message}`);
  }
  refresh();
});

$("payee-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("/api/payees", { address: f.get("address") });
    e.target.reset();
    toast("Payee added to the allowlist.");
  } catch (err) {
    toast(`Could not add payee: ${err.message}`);
  }
  refresh();
});

$("revoke-btn").addEventListener("click", async () => {
  try {
    const { txHash } = await api("/api/revoke", {});
    toast(`Mandate revoked in tx ${txHash}. The agent can no longer pay.`, 7000);
  } catch (err) {
    toast(`Revoke failed: ${err.message}`);
  }
  refresh();
});

refresh().catch((e) => {
  $("conn").textContent = `cannot reach the demo server: ${e.message}`;
});
