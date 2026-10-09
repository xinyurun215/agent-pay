import { readFileSync } from "node:fs";

import { HttpError } from "./errors.js";
import { MERCHANT_NAME } from "./types.js";

/** Official quick-sandbox OpenAPI gateway from the alipay-aipay skill. */
export const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";

/** Only legal service id for AI 按量付费 sandbox bills. Production must replace it. */
export const SANDBOX_SERVICE_ID = "api_mock_service_id";

/** Resource the agent purchases. Verification requires this exact id. */
export const PURCHASE_RESOURCE_PATH = "/agent/purchase";

export interface A2MConfig {
  appId: string;
  /** PKCS#1 DER, base64, from `appIds[0].appPrivatePkcsKey`. No PEM framing. */
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  sellerId: string;
  serviceId: string;
  sellerName: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(500, "sandbox_config_invalid", `Alipay sandbox config is missing ${field}`);
  }
  return value.trim();
}

/**
 * Map the skill's `.alipay-sandbox.json` into the Node.js SDK fields.
 * Non-Java runtimes use `appPrivatePkcsKey` (PKCS#1), not `appPrivateKey`.
 */
export function parseSandboxConfig(raw: unknown): A2MConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpError(500, "sandbox_config_invalid", "Alipay sandbox config must be a JSON object");
  }
  const record = raw as {
    appIds?: Array<Record<string, unknown>>;
    sandboxAccounts?: { partner?: { userId?: unknown } };
  };
  const app = record.appIds?.[0];
  if (!app) {
    throw new HttpError(500, "sandbox_config_invalid", "Alipay sandbox config is missing appIds[0]");
  }
  const gateway = process.env.ALIPAY_GATEWAY?.trim() || SANDBOX_GATEWAY;
  const serviceId = process.env.ALIPAY_SERVICE_ID?.trim() || SANDBOX_SERVICE_ID;
  if (gateway !== SANDBOX_GATEWAY && serviceId === SANDBOX_SERVICE_ID) {
    throw new HttpError(
      500,
      "sandbox_service_id_not_for_production",
      "api_mock_service_id is only valid with the Alipay sandbox gateway",
    );
  }
  return {
    appId: requiredString(app.appId, "appId"),
    privateKey: requiredString(app.appPrivatePkcsKey, "appPrivatePkcsKey"),
    alipayPublicKey: requiredString(app.alipayPublicKey, "alipayPublicKey"),
    gateway,
    sellerId: requiredString(record.sandboxAccounts?.partner?.userId, "sandboxAccounts.partner.userId"),
    serviceId,
    sellerName: MERCHANT_NAME,
  };
}

export function loadSandboxConfig(filePath: string): A2MConfig | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  return parseSandboxConfig(JSON.parse(text) as unknown);
}
