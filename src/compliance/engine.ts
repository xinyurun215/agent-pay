import {
  BANNED_KEYWORDS,
  HS_PREFIX_RULES,
  NAME_HS_RULES,
  REQUIRED_FIELDS,
  RESTRICTED_KEYWORDS,
} from "./catalog.ts";
import type {
  DeclarationInput,
  GatedReview,
  HsRiskFlag,
  KeywordHit,
  MissingField,
  ReviewResult,
  RiskLevel,
} from "./types.ts";

const TEXT_FIELDS = ["goodsName", "spec", "remark"] as const;
const MAX_FIELD = 500;

export class DeclarationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function reviewDeclaration(input: DeclarationInput, now = new Date()): ReviewResult {
  assertFieldLengths(input);
  const keywordHits = scanKeywords(input);
  const hsCode = normalizeHs(input.hsCode);
  const hsRisks = [
    ...hsFormatAndPrefix(hsCode),
    ...nameHsMismatch(input, hsCode),
    ...taxCodeFlags(input),
    ...weightFlag(input),
  ];
  const missingFields = [
    ...missingRequired(input),
    ...missingExportContract(input),
    ...missingLicense(input, keywordHits),
  ];

  return {
    shipmentRef: text(input.shipmentRef) || "UNREF",
    riskLevel: rollup(keywordHits, hsRisks, missingFields),
    keywordHits,
    hsRisks,
    missingFields,
    checkedAt: now.toISOString(),
  };
}

export function gateReview(result: ReviewResult, reveal: boolean): GatedReview {
  return {
    shipmentRef: result.shipmentRef,
    riskLevel: result.riskLevel,
    keywordHitCount: result.keywordHits.length,
    hsRiskCount: result.hsRisks.length,
    missingFieldCount: result.missingFields.length,
    keywordHits: reveal ? result.keywordHits : null,
    hsRisks: reveal ? result.hsRisks : null,
    missingFields: reveal ? result.missingFields : null,
    checkedAt: result.checkedAt,
  };
}

function assertFieldLengths(input: DeclarationInput): void {
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > MAX_FIELD) {
      throw new DeclarationError("FIELD_TOO_LONG", `单个栏位不能超过 ${MAX_FIELD} 字`);
    }
  }
}

function scanKeywords(input: DeclarationInput): KeywordHit[] {
  const hits: KeywordHit[] = [];
  const banned = [...BANNED_KEYWORDS].sort((a, b) => b.keyword.length - a.keyword.length);
  const restricted = [...RESTRICTED_KEYWORDS].sort((a, b) => b.keyword.length - a.keyword.length);

  for (const field of TEXT_FIELDS) {
    const value = text(input[field]);
    if (!value) continue;
    for (const rule of banned) {
      if (value.includes(rule.keyword)) {
        hits.push({ field, keyword: rule.keyword, list: "banned", message: rule.message });
      }
    }
    for (const rule of restricted) {
      if (value.includes(rule.keyword)) {
        hits.push({ field, keyword: rule.keyword, list: "restricted", message: rule.message });
      }
    }
  }
  return hits;
}

function hsFormatAndPrefix(hsCode: string | null): HsRiskFlag[] {
  if (!hsCode) return [];
  const flags: HsRiskFlag[] = [];
  if (!/^\d{10}$/.test(hsCode)) {
    flags.push({
      level: "review",
      code: "HS_FORMAT",
      message: "HS 编码需为 10 位数字（已去掉空格、点号和横线）",
      hsCode,
    });
  }
  const matched = HS_PREFIX_RULES.filter((rule) => hsCode.startsWith(rule.prefix));
  const longest = matched.reduce((max, rule) => Math.max(max, rule.prefix.length), 0);
  for (const rule of matched) {
    if (rule.prefix.length !== longest) continue;
    flags.push({
      level: rule.level,
      code: rule.code,
      message: rule.message,
      hsCode,
    });
  }
  return flags;
}

function nameHsMismatch(input: DeclarationInput, hsCode: string | null): HsRiskFlag[] {
  if (!hsCode) return [];
  const name = `${text(input.goodsName)} ${text(input.spec)}`;
  const flags: HsRiskFlag[] = [];
  for (const rule of NAME_HS_RULES) {
    const named = rule.keywords.some((keyword) => name.includes(keyword));
    const classified = rule.prefixes.some((prefix) => hsCode.startsWith(prefix));
    if (named && !classified) {
      flags.push({ level: "review", code: rule.code, message: rule.message, hsCode });
    }
  }
  return flags;
}

function taxCodeFlags(input: DeclarationInput): HsRiskFlag[] {
  const taxCode = text(input.taxCode);
  const flags: HsRiskFlag[] = [];
  if (taxCode && !/^\d{19}$/.test(taxCode)) {
    flags.push({
      level: "review",
      code: "TAX_CODE_FORMAT",
      message: "税收分类编码需为 19 位数字",
      hsCode: null,
    });
  }
  if (text(input.tradeMode).includes("跨境") && !taxCode) {
    flags.push({
      level: "review",
      code: "TAX_CODE_MISSING",
      message: "监管方式含跨境，需填写 19 位税收分类编码",
      hsCode: null,
    });
  }
  return flags;
}

function weightFlag(input: DeclarationInput): HsRiskFlag[] {
  const gross = numberOrNull(input.grossWeightKg);
  const net = numberOrNull(input.netWeightKg);
  if (gross === null || net === null || net <= gross) return [];
  return [{
    level: "review",
    code: "WEIGHT_NET_GT_GROSS",
    message: "净重大于毛重",
    hsCode: null,
  }];
}

function missingRequired(input: DeclarationInput): MissingField[] {
  return REQUIRED_FIELDS.filter((field) => !text(input[field.field as keyof DeclarationInput])).map((field) => ({
    field: field.field,
    label: field.label,
    reason: field.reason,
  }));
}

function missingExportContract(input: DeclarationInput): MissingField[] {
  const direction = normalizeDirection(input.direction);
  if (direction !== "export" || text(input.contractNo)) return [];
  return [{ field: "contractNo", label: "合同协议号", reason: "出口申报需填写合同协议号" }];
}

function missingLicense(input: DeclarationInput, hits: KeywordHit[]): MissingField[] {
  if (hits.length === 0 || text(input.licenseNo)) return [];
  return [{ field: "licenseNo", label: "许可证号", reason: "命中禁限关键词，需补许可证号" }];
}

function rollup(hits: KeywordHit[], risks: HsRiskFlag[], missing: MissingField[]): RiskLevel {
  if (hits.some((hit) => hit.list === "banned") || risks.some((risk) => risk.level === "hold")) {
    return "hold";
  }
  if (hits.length > 0 || risks.length > 0 || missing.length > 0) return "review";
  return "pass";
}

export function normalizeHs(value: string | undefined): string | null {
  const raw = text(value).replace(/[\s.\-]/g, "");
  return raw || null;
}

function normalizeDirection(value: string | undefined): "import" | "export" | "" {
  const raw = text(value).toLowerCase();
  if (raw === "export" || raw === "出口") return "export";
  if (raw === "import" || raw === "进口") return "import";
  return "";
}

function numberOrNull(value: string | undefined): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}
