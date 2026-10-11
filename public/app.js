const fields = [
  "shipmentRef", "direction", "consignor", "consignee", "tradeMode", "transportMode",
  "originCountry", "destinationCountry", "goodsName", "spec", "hsCode", "taxCode",
  "quantity", "unit", "totalAmount", "currency", "grossWeightKg", "netWeightKg",
  "packages", "packageType", "contractNo", "invoiceNo", "licenseNo", "remark",
];

const state = {
  health: null,
  offers: [],
  samples: null,
  tier: "buyout",
  review: null,
  order: null,
};

const $ = (id) => document.getElementById(id);

$("fill-risky").addEventListener("click", () => fill(state.samples?.risky));
$("fill-clean").addEventListener("click", () => fill(state.samples?.clean));
$("call-skill").addEventListener("click", () => guard(() => callSkill("首次调用")));
$("pay-button").addEventListener("click", () => guard(pay));
$("query-button").addEventListener("click", () => guard(queryPayment));
$("plaintext-button").addEventListener("click", () => guard(downloadPlaintext));
$("new-buyer").addEventListener("click", () => rotateBuyer());
$("auth").addEventListener("change", syncPayButton);
$("buyerId").addEventListener("change", () => refreshEntitlement());

boot().catch((error) => setStatus(error.message));

async function boot() {
  const [health, catalog, samples] = await Promise.all([
    getJson("/api/health"),
    getJson("/api/catalog"),
    getJson("/api/samples"),
  ]);
  state.health = health;
  state.offers = catalog.offers;
  state.samples = samples;
  renderMode();
  renderTiers();
  await refreshEntitlement();
  trace("演示页就绪。规则引擎在本地，不调用大模型。");
}

async function callSkill(reason) {
  setStatus("");
  trace(`${reason}：读取 /skills/customs-compliance-review/SKILL.md`);
  trace("POST /api/skill/review");
  const review = await postJson("/api/skill/review", {
    buyerId: buyerId(),
    declaration: declarationFromForm(),
  });
  state.review = review;
  renderReview(review);
  markStep("call");
  markStep("deliver");
  syncPayButton();
  trace(`交付 ${labelDelivery(review.delivery)}`);
}

async function pay() {
  setStatus("");
  if (!state.review) {
    setStatus("先由 Agent 调用 Skill。");
    return;
  }
  if (!$("auth").checked) {
    setStatus("需要勾选授权。支付确认必须由你本人做出。");
    return;
  }
  trace(`用户授权 ${state.tier === "buyout" ? "买断" : "周期"}`);
  const order = await postJson("/api/pay/checkout", { buyerId: buyerId(), tier: state.tier });
  state.order = order;
  $("plaintext-button").hidden = false;
  if (order.mode === "sandbox-mock") {
    const paid = await postJson("/api/pay/sandbox-confirm", { orderId: order.orderId });
    state.order = paid;
    renderReceipt(paid.receipt);
    trace(`沙箱模拟支付成功，回执 ${paid.receipt.receiptNo}`);
    await callSkill("付款后按档位交付");
    await refreshEntitlement();
    return;
  }
  if (order.cashierUrl) {
    const link = $("cashier-link");
    link.href = order.cashierUrl;
    link.hidden = false;
  }
  $("query-button").hidden = false;
  setStatus("收银台已生成。付完后点「查询支付结果」。同步跳转不算成功。");
  trace("已创建支付宝收银台，等待用户付款");
}

async function queryPayment() {
  if (!state.order) return;
  const order = await postJson("/api/pay/query", { orderId: state.order.orderId });
  state.order = order;
  if (!order.receipt) {
    setStatus("支付宝侧还没有成功交易。");
    return;
  }
  renderReceipt(order.receipt);
  trace(`查询到回执 ${order.receipt.receiptNo}`);
  await callSkill("付款后按档位交付");
  await refreshEntitlement();
}

async function downloadPlaintext() {
  if (!state.order) return;
  const response = await fetch(`/api/pay/orders/${encodeURIComponent(state.order.orderId)}/plaintext?buyerId=${encodeURIComponent(buyerId())}`);
  const body = await response.json();
  const view = $("plaintext-view");
  view.hidden = false;
  if (!response.ok) {
    view.textContent = `${body.error?.code || "ERROR"}\n${body.error?.message || "无法下载明文"}`;
    trace("明文存档被拒绝");
    return;
  }
  view.textContent = body.skillPlaintext.text;
  trace("已下载买断明文");
}

async function refreshEntitlement() {
  const data = await getJson(`/api/entitlement?buyerId=${encodeURIComponent(buyerId())}`);
  const line = $("entitlement-line");
  const entitlement = data.entitlement;
  if (!entitlement) {
    line.textContent = "当前没有权益。先调用 Skill，再选择买断或周期。";
    return;
  }
  if (entitlement.tier === "buyout" && entitlement.active) {
    line.textContent = "买断已生效：后续调用交付完整明文，并可下载 Skill 明文。";
    return;
  }
  if (entitlement.active) {
    line.textContent = `周期权益生效中，剩余 ${entitlement.callsRemaining} 次，到期 ${entitlement.periodEnd}。不交付明文存档，不自动续费。`;
    return;
  }
  line.textContent = "周期权益已用完或已过期。可以再次购买，或换一个买家演示另一档。";
}

function renderMode() {
  const health = state.health;
  $("mode-label").textContent = health.modeLabel;
  $("mode-note").textContent = health.degradedFrom
    ? `由 ${health.degradedFrom} 降级`
    : (health.realFunds ? "真实资金" : "非真实资金");
  const missing = health.missing?.length
    ? `离开沙箱模拟还缺：${health.missing.join("、")}。SkillPay 商品上架与 PAYATHON 报名材料也不在本仓库。`
    : "支付宝密钥已配置。支付成功仍以异步通知或主动查询为准。";
  $("missing").textContent = missing;
  $("pay-button").textContent = health.mode === "sandbox-mock" ? "确认沙箱支付" : "创建收银台订单";
}

function renderTiers() {
  const root = $("tiers");
  root.replaceChildren();
  for (const offer of state.offers) {
    const label = document.createElement("label");
    label.className = `tier${offer.tier === state.tier ? " on" : ""}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "tier";
    input.value = offer.tier;
    input.checked = offer.tier === state.tier;
    input.addEventListener("change", () => {
      state.tier = offer.tier;
      renderTiers();
      syncPayButton();
    });
    const title = document.createElement("strong");
    title.textContent = offer.tier === "buyout" ? "买断" : "周期";
    const price = document.createElement("b");
    price.textContent = `¥${offer.amount}`;
    const summary = document.createElement("span");
    summary.textContent = offer.summary;
    label.append(input, title, price, summary);
    root.append(label);
  }
}

function renderReview(payload) {
  $("result-empty").hidden = true;
  const root = $("result-body");
  root.hidden = false;
  root.replaceChildren();
  const review = payload.review;
  const level = document.createElement("div");
  level.className = `level ${review.riskLevel}`;
  const name = document.createElement("strong");
  name.textContent = { hold: "拦截", review: "复核", pass: "通过" }[review.riskLevel];
  const meta = document.createElement("span");
  meta.textContent = labelDelivery(payload.delivery);
  level.append(name, meta);
  const counts = document.createElement("div");
  counts.className = "counts";
  counts.append(
    count("关键词", review.keywordHitCount),
    count("HS / 税码", review.hsRiskCount),
    count("缺失栏位", review.missingFieldCount),
  );
  root.append(level, counts);
  if (payload.delivery === "locked") {
    const note = document.createElement("p");
    note.textContent = "Skill 已跑完。明细和 Skill 明文仍锁定，付款后才按档位交付。";
    root.append(note);
    return;
  }
  root.append(hitList("关键词", review.keywordHits, (hit) => `${hit.list === "banned" ? "禁止" : "限制"} · ${hit.field} · ${hit.keyword} · ${hit.message}`));
  root.append(hitList("HS / 税码", review.hsRisks, (flag) => `${flag.code} · ${flag.message}`));
  root.append(hitList("缺失栏位", review.missingFields, (field) => `${field.label}（${field.field}）· ${field.reason}`));
  if (payload.delivery === "subscription_call") {
    const note = document.createElement("p");
    note.textContent = `这是当期这一次调用的结果，剩余 ${payload.entitlement?.callsRemaining ?? 0} 次。没有 Skill 明文，也没有可下载存档。`;
    root.append(note);
  }
}

function renderReceipt(receipt) {
  markStep("paid");
  const article = $("receipt");
  article.hidden = false;
  $("receipt-stamp").textContent = receipt.modeLabel;
  const fields = [
    ["回执号", receipt.receiptNo],
    ["商户订单号", receipt.outTradeNo],
    ["交易号", receipt.tradeNo],
    ["状态", receipt.tradeStatus],
    ["档位", receipt.tier === "buyout" ? "买断" : "周期"],
    ["金额", `${receipt.amount} ${receipt.currency}`],
    ["商品", receipt.subject],
    ["交付范围", receipt.deliveryScope],
    ["付款时间", receipt.paidAt],
    ["真实资金", receipt.realFunds ? "是" : "否"],
  ];
  const dl = $("receipt-fields");
  dl.replaceChildren();
  for (const [key, value] of fields) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function fill(sample) {
  if (!sample) return;
  for (const field of fields) {
    $(field).value = sample[field] ?? "";
  }
  trace(`已填入 ${sample.shipmentRef || "样例"}，尚未调用。`);
}

function declarationFromForm() {
  const declaration = {};
  for (const field of fields) {
    const value = $(field).value.trim();
    if (value) declaration[field] = value;
  }
  return declaration;
}

function rotateBuyer() {
  $("buyerId").value = `judge-${Date.now().toString(36)}`;
  state.review = null;
  state.order = null;
  $("result-body").hidden = true;
  $("result-empty").hidden = false;
  $("receipt").hidden = true;
  $("plaintext-view").hidden = true;
  $("plaintext-button").hidden = true;
  $("cashier-link").hidden = true;
  $("query-button").hidden = true;
  $("auth").checked = false;
  setStatus("");
  syncPayButton();
  refreshEntitlement().catch((error) => setStatus(error.message));
  trace("已更换买家标识。");
}

function syncPayButton() {
  const ready = Boolean(state.review) && $("auth").checked;
  $("pay-button").disabled = !ready;
}

function buyerId() {
  return $("buyerId").value.trim() || "judge-demo";
}

function markStep(step) {
  document.querySelector(`[data-step="${step}"]`)?.classList.add("on");
}

function count(label, value) {
  const div = document.createElement("div");
  const span = document.createElement("span");
  span.textContent = label;
  div.append(span, document.createTextNode(String(value)));
  return div;
}

function hitList(title, items, line) {
  const wrap = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = title;
  wrap.append(heading);
  if (!items || items.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "无";
    wrap.append(empty);
    return wrap;
  }
  const list = document.createElement("ul");
  list.className = "hits";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = line(item);
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}

function labelDelivery(delivery) {
  if (delivery === "buyout_plaintext") return "买断明文";
  if (delivery === "subscription_call") return "当期调用";
  return "未付款，明细锁定";
}

function trace(message) {
  const item = document.createElement("li");
  item.textContent = message;
  $("trace").append(item);
}

function setStatus(message) {
  $("status").textContent = message;
}

function guard(action) {
  return action().catch((error) => setStatus(error.message));
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "请求失败");
  return body;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "请求失败");
  return body;
}
