import path from "node:path";

import { loadSandboxConfig } from "./sandbox-config.js";
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const { server } = createApp({
  databasePath: path.resolve("data/agent-pay.sqlite"),
  config: loadSandboxConfig(path.resolve(".alipay-sandbox.json")),
  adminToken: process.env.ADMIN_TOKEN ?? "",
  userToken: process.env.USER_TOKEN ?? "",
  demoPrincipal: process.env.DEMO_PRINCIPAL,
});
server.listen(port, host, () => {
  console.log(`Agent Pay sandbox listening on http://${host}:${port}`);
});
