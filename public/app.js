const MERCHANT_ID = "stationery-demo-001";
const SAMPLE_NOW = "2026-10-09T10:00:00+08:00";

const resultEl = document.querySelector("#result");
const reasonEl = document.querySelector("#reason");
const tokenEl = document.querySelector("#token-view");
const draftsEl = document.querySelector("#drafts");
const catalogEl = document.querySelector("#catalog");
const authStateEl = document.querySelector("#auth-state");

let currentToken = null;
let lastOutTradeNo = null;
let catalog = [];

const adminTokenEl = document.querySelector("#admin-token");
const userTokenEl = document.querySelector("#user-token");
const storedAdminToken = sessionStorage.getItem("agent-pay-admin-token");
const storedUserToken = sessionStorage.getItem("agent-pay-user-token");
if (storedAdminToken) adminTokenEl.value = storedAdminToken;
if (storedUserToken) userTokenEl.value = storedUserToken;
adminTokenEl.addEventListener("input", () => {
  sessionStorage.setItem("agent-pay-admin-token", adminTokenEl.value.trim());
});
userTokenEl.addEventListener("input", () => {
  sessionStorage.setItem("agent-pay-user-token", userTokenEl.value.trim());
});

function authHeaders() {
  const admin = adminTokenEl.value.trim();
  const user = userTokenEl.value.trim();
  return {
    ...(admin ? { authorization: `Bearer ${admin}` } : {}),
    ...(user ? { "x-user-authorization": `Bearer ${user}` } : {}),
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  return { status: response.status, body };
}

function show(payload, status) {
  const reason = payload.deny_reason;
  if (reason) {
    reasonEl.textContent = "";
    const badge = document.createElement("span");
    badge.className = "reason";
    badge.textContent = reason;
    reasonEl.append(badge);
  } else if (payload.page_redirection_data) {
    reasonEl.innerHTML = `<span class="reason ok">page.pay</span>`;
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
  const defaults = await api("/authorization/defaults");
  fillAuthorization(defaults.body.defaults);
  if (!adminTokenEl.value.trim()) {
    authStateEl.textContent = "填入管理令牌后可读取已保存策略。用户确认需要另一个用户令牌。";
    return;
  }
  const { status, body } = await api("/authorization");
  if (status !== 200) {
    authStateEl.textContent = body.message ?? "无法读取授权";
    return;
  }
  if (body.authorization) fillAuthorization(body.authorization);
  const confirmation = body.confirmation;
  const active = confirmation && !confirmation.revoked_at && confirmation.scope_version === body.scope_version;
  authStateEl.textContent = active
    ? `用户已确认。主体 ${confirmation.principal}，范围版本 ${confirmation.scope_version}，确认于 ${confirmation.confirmed_at}，可撤销。`
    : body.authorized
      ? `策略版本 ${body.scope_version} 已保存，等待用户确认后才能签发令牌。`
      : "授权尚未保存。保存后由用户确认，才能签发令牌。";
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
    const link = document.createElement("button");
    link.type = "button";
    link.className = "secondary";
    link.textContent = "打开收据";
    link.addEventListener("click", async () => {
      const response = await fetch(draft.receipt_url, { headers: authHeaders() });
      const html = await response.text();
      const blob = new Blob([html], { type: "text/html" });
      window.open(URL.createObjectURL(blob));
    });
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

async function confirmUser() {
  const { status, body } = await api("/authorization/confirm", {
    method: "POST",
    body: JSON.stringify({ principal: document.querySelector("#principal").value.trim() }),
  });
  show(body, status);
  await refreshAuth();
  return body;
}

async function payWith(payload) {
  const { status, body } = await api("/agent/purchase", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (body.out_trade_no) lastOutTradeNo = body.out_trade_no;
  show({ http_status: status, ...body }, status);
  await refreshDrafts();
  if (currentToken) {
    const token = await api(`/payment-tokens/${encodeURIComponent(currentToken)}`);
    if (token.body.ok) {
      tokenEl.textContent = `${token.body.token}\nused ${token.body.used} · single_use ${token.body.single_use}\nexpires ${token.body.expires_at}`;
    }
  }
  return { status, body };
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
  await confirmUser();
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

document.querySelector("#confirm-auth").addEventListener("click", () => confirmUser());
document.querySelector("#revoke-auth").addEventListener("click", async () => {
  const { status, body } = await api("/authorization/revoke", { method: "POST" });
  show(body, status);
  await refreshAuth();
});
document.querySelector("#issue-token").addEventListener("click", () => issueToken());
document.querySelector("#confirm-trade").addEventListener("click", async () => {
  if (!lastOutTradeNo) {
    show({ ok: false, error: "order_required", message: "请先创建收银台链接" }, 400);
    return;
  }
  const { status, body } = await api(`/agent/orders/${encodeURIComponent(lastOutTradeNo)}/confirm`, {
    method: "POST",
  });
  show({ http_status: status, ...body }, status);
  await refreshDrafts();
});

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
    if (first.status !== 200) return;
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
if (adminTokenEl.value.trim()) await refreshDrafts();
