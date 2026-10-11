import crypto from "node:crypto";

export function buildSignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

export function signRsa2(content: string, privateKeyPem: string): string {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(content, "utf8");
  signer.end();
  return signer.sign(normalizePrivateKey(privateKeyPem), "base64");
}

export function verifyRsa2(content: string, signature: string, publicKeyPem: string): boolean {
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(content, "utf8");
  verifier.end();
  try {
    return verifier.verify(normalizePublicKey(publicKeyPem), signature, "base64");
  } catch {
    return false;
  }
}

export function pagePayUrl(gateway: string, params: Record<string, string>, privateKeyPem: string): string {
  const sign = signRsa2(buildSignContent(params), privateKeyPem);
  const query = new URLSearchParams({ ...params, sign });
  const base = gateway.endsWith("?") ? gateway.slice(0, -1) : gateway;
  return `${base}?${query.toString()}`;
}

export function alipayTimestamp(now: Date): string {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 19).replace("T", " ");
}

export function extractJsonObject(raw: string, responseKey: string): string | null {
  const marker = `"${responseKey}":`;
  const markerAt = raw.indexOf(marker);
  if (markerAt < 0) return null;
  let index = markerAt + marker.length;
  while (raw[index] === " " || raw[index] === "\n") index += 1;
  if (raw[index] !== "{") return null;
  return sliceJsonValue(raw, index);
}

function sliceJsonValue(raw: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

export function normalizePrivateKey(value: string): string {
  const trimmed = unwrapQuotes(value).replace(/\\n/g, "\n").trim();
  if (trimmed.includes("BEGIN")) return trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${wrap64(trimmed)}\n-----END PRIVATE KEY-----`;
}

export function normalizePublicKey(value: string): string {
  const trimmed = unwrapQuotes(value).replace(/\\n/g, "\n").trim();
  if (trimmed.includes("BEGIN")) return trimmed;
  return `-----BEGIN PUBLIC KEY-----\n${wrap64(trimmed)}\n-----END PUBLIC KEY-----`;
}

function unwrapQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function wrap64(value: string): string {
  const compact = value.replace(/\s+/g, "");
  return compact.replace(/.{1,64}/g, "$&\n").trim();
}
