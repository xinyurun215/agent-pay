import { AlipaySdk } from "alipay-sdk";

import { PAGE_PAY_METHOD, type PagePayParams, type ProductPayClient } from "./product-pay.js";
import type { SandboxConfig } from "./sandbox-config.js";

/**
 * Demo client. `createPagePayUrl` is local SDK pageExecute (GET cashier URL).
 * `queryTrade` calls alipay.trade.query on the sandbox gateway.
 * This module is not a test double.
 */
export function createProductPayClient(config: SandboxConfig): ProductPayClient {
  const sdk = new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    keyType: "PKCS1",
    timeout: 30_000,
  });
  return {
    createPagePayUrl(params: PagePayParams): string {
      return sdk.pageExecute(PAGE_PAY_METHOD, "GET", {
        notifyUrl: params.notifyUrl,
        returnUrl: params.returnUrl,
        bizContent: params.bizContent,
      });
    },
    async queryTrade(outTradeNo: string): Promise<Record<string, unknown>> {
      const result = await sdk.exec("alipay.trade.query", {
        bizContent: { out_trade_no: outTradeNo },
      });
      return result as unknown as Record<string, unknown>;
    },
    checkNotifySign(postData: Record<string, string>): boolean {
      return sdk.checkNotifySign(postData);
    },
  };
}
