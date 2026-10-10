import path from "node:path";

import { loadSandboxConfig } from "./sandbox-config.js";
import { createApp, resolvePublicBaseUrl } from "./server.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const localDegraded = process.env.LOCAL_DEGRADED === "1";
const configuredBase = process.env.PUBLIC_BASE_URL;
if (localDegraded && configuredBase?.trim()) {
  throw new Error(
    "Unset PUBLIC_BASE_URL when LOCAL_DEGRADED=1. Settle with POST /agent/orders/:id/confirm (alipay.trade.query).",
  );
}
if (!localDegraded && !configuredBase?.trim()) {
  throw new Error(
    "PUBLIC_BASE_URL is required and must be a public https origin. For a machine Alipay cannot reach, set LOCAL_DEGRADED=1 and settle with alipay.trade.query.",
  );
}

const { server } = createApp({
  databasePath: path.resolve("data/agent-pay.sqlite"),
  config: loadSandboxConfig(path.resolve(".alipay-sandbox.json")),
  adminToken: process.env.ADMIN_TOKEN ?? "",
  userToken: process.env.USER_TOKEN ?? "",
  demoPrincipal: process.env.DEMO_PRINCIPAL,
  publicBaseUrl: localDegraded ? null : resolvePublicBaseUrl(configuredBase, { https: true }),
  trustProxy: !localDegraded && process.env.TRUST_PROXY === "1",
});
server.listen(port, host, () => {
  console.log(`Agent Pay sandbox listening on http://${host}:${port}`);
});
