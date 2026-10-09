const MERCHANT_ID = "stationery-demo-001";
const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";

const resultEl = document.querySelector("#result");
const reasonEl = document.querySelector("#reason");
const tokenEl = document.querySelector("#token-view");
const draftsEl = document.querySelector("#drafts");
const catalogEl = document.querySelector("#catalog");
const authStateEl = document.querySelector("#auth-state");

let currentToken = null;
let catalog = [];

function decodeBase64Url(value) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  const paymentNeeded = response.headers.get("payment-needed");
  let payment_needed = null;
  if (paymentNeeded) {
    try {
      payment_needed = JSON.parse(decodeBase64Url(paymentNeeded));
    } catch {
      payment_needed = null;
    }
  }
  return { status: response.status, body, payment_needed };
}

function show(payload, status) {
  const reason = payload.deny_reason;
  if (reason) {
    reasonEl.textContent = "";
    const badge = document.createElement("span");
    badge.className = "reason";
    badge.textContent = reason;
    reasonEl.append(badge);
  } else if (status === 402) {
    reasonEl.innerHTML = `<span class="reason">Payment-Needed</span>`;
  } else if (payload.ok) {
    reasonEl.innerHTML = `<span class="reason ok">ok ${status}</span>`;
  } else {
    reasonEl.textContent = "";
    const badge = document.createElement("span");
    badge.className = "reason";
    badge.textContent = payload.error ?? payload.code ?? "error";
    reasonEl.append(badge);
  }
  resultEl.textContent = JSON.stringify(payload, null, 2);
}

function splitList(value) {
  return value
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function authorizationFromForm() {
  return {
    budget: {
      per_order_cents: Number(document.querySelector("#per-order").value),
      daily_cents: Number(document.querySelector("#daily").value),
      total_cents: Number(document.querySelector("#total").value),
    },
    valid_from: document.querySelector("#valid-from").value.trim(),
    valid_to: document.querySelector("#valid-to").value.trim(),
    merchant_whitelist: splitList(document.querySelector("#whitelist").value),
    sku_keywords: splitList(document.querySelector("#keywords").value),
    category: "desktop_stationery",
  };
}

function fillAuthorization(authorization) {
  document.querySelector("#per-order").value = authorization.budget.per_order_cents;
  document.querySelector("#daily").value = authorization.budget.daily_cents;
  document.querySelector("#total").value = authorization.budget.total_cents;
  document.querySelector("#valid-from").value = authorization.valid_from;
  document.querySelector("#valid-to").value = authorization.valid_to;
  document.querySelector("#whitelist").value = authorization.merchant_whitelist.join(", ");
  document.querySelector("#keywords").value = authorization.sku_keywords.join(", ");
}

async function refreshClock() {
  const { body } = await api("/sandbox/clock");
  document.querySelector("#clock-now").textContent = body.now;
  document.querySelector("#clock-source").textContent =
    body.source === "sandbox" ? "来源：手动设定的沙箱时钟" : "来源：系统时钟";
}

async function refreshAuth() {
  const { body } = await api("/authorization");
  const source = body.authorization ?? body.defaults;
  fillAuthorization(source);
  authStateEl.textContent = body.authorized
    ? "授权已生效。可以签发支付令牌。"
    : "授权尚未保存。保存后才能签发令牌。";
}

function renderCatalog() {
  catalogEl.replaceChildren();
  for (const sku of catalog) {
    const row = document.createElement("div");
    row.className = "sku";
    const allowed = sku.allowed_by_default_keywords ? "默认可购" : "用于拒付演示";
    const badgeClass = sku.allowed_by_default_keywords ? "yes" : "no";
    row.innerHTML = `<div><strong></strong><span class="meta"></span></div><span class="badge ${badgeClass}"></span>`;
    row.querySelector("strong").textContent = sku.name;
    row.querySelector(".meta").textContent = `${sku.sku_id} · ${sku.unit_price_cents} 分`;
    row.querySelector(".badge").textContent = allowed;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.value = sku.sku_id === "sku-pen" ? "1" : "0";
    input.dataset.sku = sku.sku_id;
    input.setAttribute("aria-label", `${sku.name} 数量`);
    row.append(input);
    catalogEl.append(row);
  }
}

function selectedItems() {
  return [...catalogEl.querySelectorAll("input")].flatMap((input) => {
    const quantity = Number(input.value);
    if (!Number.isInteger(quantity) || quantity < 1) return [];
    return [{ sku_id: input.dataset.sku, quantity }];
  });
}

async function refreshDrafts() {
  const { body } = await api("/expense-drafts");
  const drafts = body.expense_drafts ?? [];
  if (drafts.length === 0) {
    draftsEl.textContent = "还没有草稿";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>草稿</th><th>订单</th><th>金额（分）</th><th>商户</th><th>支付时间</th><th>收据</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const draft of drafts) {
    const row = document.createElement("tr");
    const cells = [
      draft.expense_draft_id,
      draft.order_id,
      String(draft.amount_cents),
      draft.merchant_name,
      draft.paid_at,
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const linkCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = draft.receipt_url;
    link.textContent = "打开收据";
    link.target = "_blank";
    link.rel = "noreferrer";
    linkCell.append(link);
    row.append(linkCell);
    tbody.append(row);
  }
  table.append(tbody);
  draftsEl.replaceChildren(table);
}

async function saveAuthorization() {
  const { status, body } = await api("/authorization", {
    method: "PUT",
    body: JSON.stringify(authorizationFromForm()),
  });
  show(body, status);
  await refreshAuth();
  return body;
}

async function issueToken() {
  const { status, body } = await api("/payment-tokens", { method: "POST" });
  show(body, status);
  if (body.ok) {
    currentToken = body.token;
    tokenEl.textContent = `${body.token}\nissued ${body.issued_at}\nexpires ${body.expires_at}\nttl ${body.ttl_seconds}s · single_use ${body.single_use}`;
  }
  return body;
}

async function payWith(payload) {
  const { status, body, payment_needed } = await api("/agent/purchase", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  show({ http_status: status, ...body, payment_needed }, status);
  await refreshDrafts();
  if (currentToken) {
    const token = await api(`/payment-tokens/${encodeURIComponent(currentToken)}`);
    if (token.body.ok) {
      tokenEl.textContent = `${token.body.token}\nused ${token.body.used} · single_use ${token.body.single_use}\nexpires ${token.body.expires_at}`;
    }
  }
  return { status, body, payment_needed };
}

async function prepareDemo() {
  await api("/sandbox/reset", { method: "POST" });
  currentToken = null;
  tokenEl.textContent = "尚未签发";
  await api("/sandbox/clock", {
    method: "POST",
    body: JSON.stringify({ now: SAMPLE_NOW }),
  });
  await api("/authorization", {
    method: "PUT",
    body: JSON.stringify({
      budget: { per_order_cents: 50000, daily_cents: 200000, total_cents: 500000 },
      valid_from: "2026-10-09T00:00:00+08:00",
      valid_to: "2026-10-16T23:59:59+08:00",
      merchant_whitelist: [MERCHANT_ID],
      category: "desktop_stationery",
      sku_keywords: ["签字笔", "A4纸", "文件夹"],
    }),
  });
  await refreshClock();
  await refreshAuth();
  await refreshDrafts();
}

document.querySelector("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveAuthorization();
});

document.querySelector("#use-sample-time").addEventListener("click", async () => {
  const { status, body } = await api("/sandbox/clock", {
    method: "POST",
    body: JSON.stringify({ now: SAMPLE_NOW }),
  });
  show(body, status);
  await refreshClock();
});

document.querySelector("#issue-token").addEventListener("click", () => issueToken());

document.querySelector("#pay").addEventListener("click", async () => {
  if (!currentToken) {
    show({ ok: false, error: "token_required", message: "请先签发支付令牌" }, 400);
    return;
  }
  const items = selectedItems();
  if (items.length === 0) {
    show({ ok: false, error: "items_required", message: "请至少选择一件商品" }, 400);
    return;
  }
  const clientRaw = document.querySelector("#client-amount").value.trim();
  const payload = {
    token: currentToken,
    merchant_id: document.querySelector("#merchant-id").value.trim(),
    items,
  };
  if (clientRaw !== "") payload.amount_cents = Number(clientRaw);
  await payWith(payload);
});

document.querySelector("#reset").addEventListener("click", async () => {
  const { status, body } = await api("/sandbox/reset", { method: "POST" });
  currentToken = null;
  tokenEl.textContent = "尚未签发";
  show(body, status);
  await refreshClock();
  await refreshAuth();
  await refreshDrafts();
});

const denyHandlers = {
  async over_budget() {
    await prepareDemo();
    const pen = catalog.find((sku) => sku.sku_id === "sku-pen");
    const quantity = Math.floor(50000 / pen.unit_price_cents) + 1;
    const token = await issueToken();
    if (!token.ok) return;
    await payWith({
      token: token.token,
      merchant_id: MERCHANT_ID,
      items: [{ sku_id: "sku-pen", quantity }],
    });
  },
  async merchant_not_allowed() {
    await prepareDemo();
    const token = await issueToken();
    if (!token.ok) return;
    await payWith({
      token: token.token,
      merchant_id: "cafe-demo-009",
      items: [{ sku_id: "sku-pen", quantity: 1 }],
    });
  },
  async expired() {
    await prepareDemo();
    const token = await issueToken();
    if (!token.ok) return;
    const past = new Date(Date.parse(token.expires_at) + 1000).toISOString();
    await api("/sandbox/clock", { method: "POST", body: JSON.stringify({ now: past }) });
    await refreshClock();
    await payWith({
      token: token.token,
      merchant_id: MERCHANT_ID,
      items: [{ sku_id: "sku-pen", quantity: 1 }],
    });
  },
  async token_reused() {
    await prepareDemo();
    const token = await issueToken();
    if (!token.ok) return;
    const first = await payWith({
      token: token.token,
      merchant_id: MERCHANT_ID,
      items: [{ sku_id: "sku-pen", quantity: 1 }],
    });
    if (first.status !== 402) return;
    await payWith({
      token: token.token,
      merchant_id: MERCHANT_ID,
      items: [{ sku_id: "sku-pen", quantity: 1 }],
    });
  },
  async sku_not_allowed() {
    await prepareDemo();
    const token = await issueToken();
    if (!token.ok) return;
    await payWith({
      token: token.token,
      merchant_id: MERCHANT_ID,
      items: [{ sku_id: "sku-mug", quantity: 1 }],
    });
  },
};

let busy = false;
for (const button of document.querySelectorAll("[data-deny]")) {
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    try {
      await denyHandlers[button.dataset.deny]();
    } finally {
      busy = false;
    }
  });
}

const loaded = await api("/catalog");
catalog = loaded.body.skus;
renderCatalog();
await refreshClock();
await refreshAuth();
await refreshDrafts();
