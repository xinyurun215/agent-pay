import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const envFile = existsSync(".env") ? ".env" : ".env.example";
process.stderr.write(`demo env file: ${envFile}\n`);

const child = spawn(process.execPath, ["--env-file=" + envFile, "--import", "tsx", "src/index.ts"], {
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
