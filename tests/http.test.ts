import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { riskySample } from "../src/compliance/samples.ts";
import { createApp } from "../src/http.ts";
import { SandboxMockGateway } from "../src/pay/gateway.ts";
import { PayService } from "../src/pay/service.ts";
import { MemoryStore } from "../src/pay/store.ts";

async function listen() {
  const gateway = new SandboxMockGateway(["ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_ALIPAY_PUBLIC_KEY"], null);
  const service = new PayService(new MemoryStore(), gateway);
  const server = createApp({
    service,
    gateway,
    publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
    skillFile: fileURLToPath(new URL("../skills/customs-compliance-review/SKILL.md", import.meta.url)),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("http walk: call, sandbox receipt, gated delivery", async () => {
  const app = await listen();
  try {
    const health = await (await fetch(`${app.base}/api/health`)).json();
    assert.equal(health.mode, "sandbox-mock");
    assert.equal(health.llm, false);
    assert.equal(health.realFunds, false);

    const buyerId = "http-judge";
    const locked = await (await fetch(`${app.base}/api/skill/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerId, declaration: riskySample }),
    })).json();
    assert.equal(locked.delivery, "locked");
    assert.ok(locked.review.keywordHitCount > 0);
    assert.equal(locked.review.keywordHits, null);

    const order = await (await fetch(`${app.base}/api/pay/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerId, tier: "buyout" }),
    })).json();
    const paid = await (await fetch(`${app.base}/api/pay/sandbox-confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: order.orderId }),
    })).json();
    assert.equal(paid.receipt.tradeStatus, "TRADE_SUCCESS");
    assert.match(paid.receipt.modeLabel, /沙箱模拟/);

    const opened = await (await fetch(`${app.base}/api/skill/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerId, declaration: riskySample }),
    })).json();
    assert.equal(opened.delivery, "buyout_plaintext");
    assert.ok(opened.review.missingFields.some((field: { field: string }) => field.field === "contractNo"));

    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /报关合规审查/);
    const skill = await fetch(`${app.base}/skills/customs-compliance-review/SKILL.md`);
    assert.equal(skill.status, 200);
    assert.match(await skill.text(), /周期付费/);
  } finally {
    await app.close();
  }
});
