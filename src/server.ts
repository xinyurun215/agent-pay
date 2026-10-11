import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env.ts";
import { createApp } from "./http.ts";
import { createGateway } from "./pay/gateway.ts";
import { PayService } from "./pay/service.ts";
import { FileStore } from "./pay/store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function start(env: NodeJS.ProcessEnv = process.env) {
  const gateway = createGateway(env);
  const dataPath = path.resolve(root, env.DATA_PATH || "data/store.json");
  const service = new PayService(new FileStore(dataPath), gateway);
  const server = createApp({
    service,
    gateway,
    publicDir: path.join(root, "public"),
    skillFile: path.join(root, "skills", "customs-compliance-review", "SKILL.md"),
  });
  const port = Number(env.PORT || 3780);
  server.listen(port, "127.0.0.1", () => {
    const where = gateway.degradedFrom
      ? `请求 ${gateway.degradedFrom}，密钥不全，已降级为沙箱模拟`
      : gateway.modeLabel;
    console.log(`报关合规审查 Skill Pay  http://127.0.0.1:${port}  ${where}`);
  });
  return server;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  loadEnvFile(path.join(root, ".env"));
  start();
}
