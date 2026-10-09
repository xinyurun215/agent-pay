import { AlipaySdk } from "alipay-sdk";

import type { AlipayExecutor } from "./a2m.js";
import type { A2MConfig } from "./sandbox-config.js";

/** Official `alipay-sdk` exec() wrapper. PKCS#1, sandbox gateway, no PEM framing added by us. */
export function createAlipayExecutor(config: A2MConfig): AlipayExecutor {
  const sdk = new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    keyType: "PKCS1",
    timeout: 30_000,
  });
  return {
    async exec(method, params) {
      const result = await sdk.exec(method, { bizContent: params.bizContent });
      return result as unknown as Record<string, unknown>;
    },
  };
}
