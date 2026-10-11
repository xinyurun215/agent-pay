const base = process.env.BASE_URL || "http://127.0.0.1:3780";

const risky = {
  shipmentRef: "DEMO-SCRIPT-001",
  direction: "export",
  consignor: "杭州澄关贸易有限公司",
  consignee: "Harbor & Co. Trading",
  tradeMode: "一般贸易",
  transportMode: "海运",
  originCountry: "中国",
  destinationCountry: "德国",
  goodsName: "装饰用象牙摆件及无人机锂电池组",
  spec: "含锂离子电池 6 只",
  hsCode: "4421.99.00.00",
  taxCode: "1090512",
  quantity: "12",
  unit: "套",
  totalAmount: "8600.00",
  currency: "USD",
  grossWeightKg: "18",
  netWeightKg: "21",
  packages: "2",
};

async function main() {
  const health = await get("/api/health");
  console.log(`环境 ${health.modeLabel}  mode=${health.mode}  realFunds=${health.realFunds}  llm=${health.llm}`);
  if (health.mode !== "sandbox-mock") {
    throw new Error("npm run demo 只走沙箱模拟。支付宝收银台需要在页面里由人确认并查询。");
  }

  const buyoutBuyer = `demo-buyout-${Date.now()}`;
  console.log("\n1. 调用 Skill（买断买家，尚未付款）");
  const locked = await post("/api/skill/review", { buyerId: buyoutBuyer, declaration: risky });
  console.log(`   delivery=${locked.delivery}  risk=${locked.review.riskLevel}  keywords=${locked.review.keywordHitCount}  hs=${locked.review.hsRiskCount}  missing=${locked.review.missingFieldCount}`);
  if (locked.delivery !== "locked" || JSON.stringify(locked).includes("象牙")) {
    throw new Error("未付款响应不应包含关键词明文");
  }

  console.log("\n2. 用户确认后沙箱支付（买断 ¥9.90）");
  const order = await post("/api/pay/checkout", { buyerId: buyoutBuyer, tier: "buyout" });
  const paid = await post("/api/pay/sandbox-confirm", { orderId: order.orderId });
  console.log(`   receipt=${paid.receipt.receiptNo}  status=${paid.receipt.tradeStatus}  tradeNo=${paid.receipt.tradeNo}`);
  console.log(`   ${paid.receipt.modeLabel}  amount=${paid.receipt.amount}  realFunds=${paid.receipt.realFunds}`);

  console.log("\n3. 按买断权益交付");
  const opened = await post("/api/skill/review", { buyerId: buyoutBuyer, declaration: risky });
  const dump = await get(`/api/pay/orders/${order.orderId}/plaintext?buyerId=${encodeURIComponent(buyoutBuyer)}`);
  console.log(`   delivery=${opened.delivery}  ivory=${opened.review.keywordHits.some((hit) => hit.keyword === "象牙")}  plaintext=${dump.skillPlaintext.text.includes("穿山甲")}`);

  const periodBuyer = `demo-period-${Date.now()}`;
  console.log("\n4. 周期档：付款后只交付当次结果");
  const periodOrder = await post("/api/pay/checkout", { buyerId: periodBuyer, tier: "subscription" });
  const periodPaid = await post("/api/pay/sandbox-confirm", { orderId: periodOrder.orderId });
  const periodCall = await post("/api/skill/review", { buyerId: periodBuyer, declaration: risky });
  const withheld = await fetch(`${base}/api/pay/orders/${periodOrder.orderId}/plaintext?buyerId=${encodeURIComponent(periodBuyer)}`);
  const withheldBody = await withheld.json();
  console.log(`   receipt=${periodPaid.receipt.receiptNo}  delivery=${periodCall.delivery}  remaining=${periodCall.entitlement.callsRemaining}`);
  console.log(`   plaintext status=${withheld.status}  code=${withheldBody.error?.code}`);
  if (withheld.status !== 403 || withheldBody.error?.code !== "PLAINTEXT_WITHHELD") {
    throw new Error("周期档不应交付明文存档");
  }
  if (JSON.stringify(periodCall).includes("穿山甲")) {
    throw new Error("周期调用不应附带 Skill 明文目录");
  }
  console.log("\n沙箱闭环完成：调用 → 锁定交付 → 支付回执 → 按档位交付。");
}

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} ${response.status}`);
  return response.json();
}

async function post(pathname, payload) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `${pathname} ${response.status}`);
  return body;
}

main().catch((error) => {
  if (error.cause?.code === "ECONNREFUSED" || error.message.includes("fetch failed")) {
    console.error(`连不上 ${base}。先在另一个终端运行 npm start。`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
