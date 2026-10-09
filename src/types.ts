export const MERCHANT_ID = "stationery-demo-001";
export const MERCHANT_NAME = "文具演示商户";
export const CATEGORY = "desktop_stationery";
export const TOKEN_TTL_SECONDS = 300;

export const DENY_REASONS = [
  "over_budget",
  "merchant_not_allowed",
  "expired",
  "token_reused",
  "sku_not_allowed",
] as const;

export type DenyReason = (typeof DENY_REASONS)[number];

export interface Budget {
  per_order_cents: number;
  daily_cents: number;
  total_cents: number;
}

export interface PaymentTokenPolicy {
  ttl_seconds: 300;
  single_use: true;
}

export interface Authorization {
  budget: Budget;
  valid_from: string;
  valid_to: string;
  merchant_whitelist: string[];
  category: string;
  sku_keywords: string[];
  payment_token: PaymentTokenPolicy;
}

export interface CatalogSku {
  sku_id: string;
  name: string;
  unit_price_cents: number;
  allowed_by_default_keywords: boolean;
}

export interface OrderLine {
  sku_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_cents: number;
}

/** Structured receipt written into an expense draft. `expense_draft_id` is optional in the schema and always set by this sandbox. */
export interface ReceiptCallback {
  order_id: string;
  amount_cents: number;
  paid_at: string;
  merchant_name: string;
  receipt_url: string;
  expense_draft_id?: string;
}

export interface ExpenseDraft {
  order_id: string;
  amount_cents: number;
  paid_at: string;
  merchant_name: string;
  receipt_url: string;
  expense_draft_id: string;
}

export interface TokenRecord {
  token: string;
  issued_at: string;
  expires_at: string;
  ttl_seconds: 300;
  single_use: true;
  used: boolean;
}

export interface OrderRecord {
  order_id: string;
  merchant_id: string;
  merchant_name: string;
  lines: OrderLine[];
  amount_cents: number;
  ignored_client_amount_cents: number | null;
  paid_at: string;
  receipt_url: string;
  expense_draft_id: string;
  token: string;
}

export interface PayCommand {
  token: string;
  merchant_id: string;
  items: Array<{ sku_id: string; quantity: number }>;
  client_amount_cents: number | null;
}

export const DEFAULT_AUTHORIZATION: Authorization = {
  budget: {
    per_order_cents: 50_000,
    daily_cents: 200_000,
    total_cents: 500_000,
  },
  valid_from: "2026-10-09T00:00:00+08:00",
  valid_to: "2026-10-16T23:59:59+08:00",
  merchant_whitelist: [MERCHANT_ID],
  category: CATEGORY,
  sku_keywords: ["签字笔", "A4纸", "文件夹"],
  payment_token: {
    ttl_seconds: TOKEN_TTL_SECONDS,
    single_use: true,
  },
};
