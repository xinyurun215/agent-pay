import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DenyError } from "./errors.js";
import { shanghaiDate } from "./time.js";
import type { AuditEvent, Authorization, ExpenseDraft, OrderLine, TokenRecord, UserConfirmation } from "./types.js";

export interface StoredOrder {
  outTradeNo: string;
  amount: string;
  amountCents: number;
  subject: string;
  productCode: string;
  goodsName: string;
  timeExpire: string;
  timeExpireMs: number;
  orderStatus: string;
  merchantId: string;
  merchantName: string;
  lines: OrderLine[];
  ignoredClientAmountCents: number | null;
  paymentToken: string | null;
  pageRedirectionData: string;
  requestFingerprint: string;
  scopeVersion: number;
  confirmationId: string;
  principal: string;
  tradeNo: string | null;
  serviceResult: string | null;
  expenseDraftId: string | null;
  receiptUrl: string | null;
  paidAt: string | null;
  spendDay: string;
  createdAt: string;
}

export interface OrderInsert {
  outTradeNo: string;
  amount: string;
  amountCents: number;
  subject: string;
  productCode: string;
  goodsName: string;
  timeExpire: string;
  timeExpireMs: number;
  merchantId: string;
  merchantName: string;
  lines: OrderLine[];
  ignoredClientAmountCents: number | null;
  paymentToken: string;
  pageRedirectionData: string;
  requestFingerprint: string;
  scopeVersion: number;
  confirmationId: string;
  principal: string;
  spendDay: string;
  createdAt: string;
}

interface SpendRow {
  amount_cents: number;
  spend_day: string;
  order_status: string;
  time_expire_ms: number;
  scope_version: number;
}

function draftFromOrder(order: StoredOrder): ExpenseDraft | null {
  if (order.orderStatus !== "TRADE_SUCCESS" || !order.serviceResult || !order.expenseDraftId) return null;
  const parsed = JSON.parse(order.serviceResult) as ExpenseDraft;
  return {
    order_id: parsed.order_id,
    amount_cents: parsed.amount_cents,
    paid_at: parsed.paid_at,
    merchant_name: parsed.merchant_name,
    receipt_url: parsed.receipt_url,
    expense_draft_id: parsed.expense_draft_id,
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS authorization_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    authorized INTEGER NOT NULL,
    scope_version INTEGER NOT NULL,
    payload TEXT
  );
  CREATE TABLE IF NOT EXISTS user_confirmation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    confirmation_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_version INTEGER NOT NULL,
    confirmed_at TEXT NOT NULL,
    revocable INTEGER NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    principal TEXT,
    detail TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_tokens (
    token TEXT PRIMARY KEY,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    single_use INTEGER NOT NULL,
    used INTEGER NOT NULL,
    confirmation_id TEXT NOT NULL,
    scope_version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    out_trade_no TEXT PRIMARY KEY,
    amount TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    subject TEXT NOT NULL,
    product_code TEXT NOT NULL,
    goods_name TEXT NOT NULL,
    time_expire TEXT NOT NULL,
    time_expire_ms INTEGER NOT NULL,
    order_status TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    merchant_name TEXT NOT NULL,
    lines_json TEXT NOT NULL,
    ignored_client_amount_cents INTEGER,
    payment_token TEXT,
    page_redirection_data TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    scope_version INTEGER NOT NULL,
    confirmation_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    trade_no TEXT,
    service_result TEXT,
    expense_draft_id TEXT,
    receipt_url TEXT,
    paid_at TEXT,
    spend_day TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS orders_trade_no
    ON orders(trade_no) WHERE trade_no IS NOT NULL;
`;

export class AgentPayDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    this.migrate();
    this.db.exec(SCHEMA);
  }

  /** Drop the previous Machine Pay table shape so the demo file can be reused. */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.size === 0) return;
    if (!names.has("page_redirection_data") || names.has("payment_needed")) {
      this.db.exec(`
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS payment_tokens;
        DROP TABLE IF EXISTS authorization_state;
        DROP TABLE IF EXISTS user_confirmation;
        DROP TABLE IF EXISTS audit_events;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.db.exec(`
      DELETE FROM orders;
      DELETE FROM payment_tokens;
      DELETE FROM user_confirmation;
      DELETE FROM audit_events;
      DELETE FROM authorization_state;
    `);
  }

  getAuthorization(): { authorized: boolean; authorization: Authorization | null; scopeVersion: number } {
    const row = this.db
      .prepare("SELECT authorized, scope_version, payload FROM authorization_state WHERE id = 1")
      .get() as { authorized: number; scope_version: number; payload: string | null } | undefined;
    if (!row || row.authorized !== 1 || !row.payload) {
      return { authorized: false, authorization: null, scopeVersion: row?.scope_version ?? 0 };
    }
    return {
      authorized: true,
      authorization: JSON.parse(row.payload) as Authorization,
      scopeVersion: row.scope_version,
    };
  }

  setAuthorization(authorization: Authorization, revokedAt: string): number {
    const current = this.getAuthorization();
    const scopeVersion = current.scopeVersion + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO authorization_state (id, authorized, scope_version, payload)
           VALUES (1, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             authorized = 1,
             scope_version = excluded.scope_version,
             payload = excluded.payload`,
        )
        .run(scopeVersion, JSON.stringify(authorization));
      this.db
        .prepare(
          `UPDATE user_confirmation
           SET revoked_at = COALESCE(revoked_at, ?)
           WHERE id = 1 AND revoked_at IS NULL`,
        )
        .run(revokedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return scopeVersion;
  }

  getConfirmation(): UserConfirmation | null {
    const row = this.db.prepare("SELECT * FROM user_confirmation WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      confirmation_id: String(row.confirmation_id),
      principal: String(row.principal),
      scope: JSON.parse(String(row.scope)) as Authorization,
      scope_version: Number(row.scope_version),
      confirmed_at: String(row.confirmed_at),
      revocable: true,
      revoked_at: row.revoked_at == null ? null : String(row.revoked_at),
    };
  }

  saveConfirmation(confirmation: UserConfirmation): void {
    this.db
      .prepare(
        `INSERT INTO user_confirmation (
           id, confirmation_id, principal, scope, scope_version, confirmed_at, revocable, revoked_at
         ) VALUES (1, ?, ?, ?, ?, ?, 1, NULL)
         ON CONFLICT(id) DO UPDATE SET
           confirmation_id = excluded.confirmation_id,
           principal = excluded.principal,
           scope = excluded.scope,
           scope_version = excluded.scope_version,
           confirmed_at = excluded.confirmed_at,
           revocable = 1,
           revoked_at = NULL`,
      )
      .run(
        confirmation.confirmation_id,
        confirmation.principal,
        JSON.stringify(confirmation.scope),
        confirmation.scope_version,
        confirmation.confirmed_at,
      );
  }

  revokeConfirmation(revokedAt: string): UserConfirmation | null {
    const current = this.getConfirmation();
    if (!current || current.revoked_at) return current;
    this.db.prepare("UPDATE user_confirmation SET revoked_at = ? WHERE id = 1 AND revoked_at IS NULL").run(revokedAt);
    return this.getConfirmation();
  }

  appendAudit(event: Omit<AuditEvent, "id">): void {
    this.db
      .prepare("INSERT INTO audit_events (at, action, principal, detail) VALUES (?, ?, ?, ?)")
      .run(event.at, event.action, event.principal, JSON.stringify(event.detail));
  }

  listAudit(): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT id, at, action, principal, detail FROM audit_events ORDER BY id ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      at: String(row.at),
      action: String(row.action),
      principal: row.principal == null ? null : String(row.principal),
      detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
    }));
  }

  insertToken(token: TokenRecord): void {
    this.db
      .prepare(
        `INSERT INTO payment_tokens (
           token, issued_at, expires_at, ttl_seconds, single_use, used, confirmation_id, scope_version
         ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(
        token.token,
        token.issued_at,
        token.expires_at,
        token.ttl_seconds,
        token.confirmation_id,
        token.scope_version,
      );
  }

  getToken(token: string): TokenRecord | null {
    const row = this.db
      .prepare(
        `SELECT token, issued_at, expires_at, ttl_seconds, single_use, used, confirmation_id, scope_version
         FROM payment_tokens WHERE token = ?`,
      )
      .get(token) as
      | {
          token: string;
          issued_at: string;
          expires_at: string;
          ttl_seconds: number;
          single_use: number;
          used: number;
          confirmation_id: string;
          scope_version: number;
        }
      | undefined;
    if (!row) return null;
    return {
      token: row.token,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      ttl_seconds: 300,
      single_use: true,
      used: row.used === 1,
      confirmation_id: row.confirmation_id,
      scope_version: row.scope_version,
    };
  }

  spentCents(now: Date, currentScopeVersion: number): { daily: number; total: number } {
    const day = shanghaiDate(now);
    const nowMs = now.getTime();
    const rows = this.db
      .prepare(
        `SELECT amount_cents, spend_day, order_status, time_expire_ms, scope_version FROM orders`,
      )
      .all() as unknown as SpendRow[];
    let daily = 0;
    let total = 0;
    for (const row of rows) {
      const unpaid = row.order_status === "WAIT_BUYER_PAY";
      if (unpaid && (row.time_expire_ms <= nowMs || row.scope_version !== currentScopeVersion)) continue;
      total += row.amount_cents;
      if (row.spend_day === day) daily += row.amount_cents;
    }
    return { daily, total };
  }

  /**
   * Read remaining daily/total budget and reserve the order in one write transaction.
   * A deny rolls back, so the token stays unused and no row is reserved.
   */
  consumeTokenAndCreateOrder(
    token: string,
    order: OrderInsert,
    reservation: { now: Date; perOrderCents: number; dailyCents: number; totalCents: number },
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const spent = this.spentCents(reservation.now, order.scopeVersion);
      if (order.amountCents > reservation.perOrderCents) {
        throw new DenyError(
          "over_budget",
          `Order amount ${order.amountCents} cents exceeds per_order_cents ${reservation.perOrderCents}`,
          { limit: "per_order", amount_cents: order.amountCents, limit_cents: reservation.perOrderCents },
        );
      }
      if (spent.daily + order.amountCents > reservation.dailyCents) {
        throw new DenyError(
          "over_budget",
          `Order amount ${order.amountCents} cents plus today's spend ${spent.daily} exceeds daily_cents ${reservation.dailyCents}`,
          {
            limit: "daily",
            amount_cents: order.amountCents,
            spent_cents: spent.daily,
            limit_cents: reservation.dailyCents,
          },
        );
      }
      if (spent.total + order.amountCents > reservation.totalCents) {
        throw new DenyError(
          "over_budget",
          `Order amount ${order.amountCents} cents plus total spend ${spent.total} exceeds total_cents ${reservation.totalCents}`,
          {
            limit: "total",
            amount_cents: order.amountCents,
            spent_cents: spent.total,
            limit_cents: reservation.totalCents,
          },
        );
      }
      const updated = this.db
        .prepare("UPDATE payment_tokens SET used = 1 WHERE token = ? AND used = 0")
        .run(token);
      if (updated.changes !== 1) {
        throw new DenyError("token_reused", "Payment token is single-use and has already been consumed");
      }
      this.db
        .prepare(
          `INSERT INTO orders (
             out_trade_no, amount, amount_cents, subject, product_code, goods_name,
             time_expire, time_expire_ms, order_status, merchant_id, merchant_name,
             lines_json, ignored_client_amount_cents, payment_token, page_redirection_data,
             request_fingerprint, scope_version, confirmation_id, principal, spend_day, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAIT_BUYER_PAY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order.outTradeNo,
          order.amount,
          order.amountCents,
          order.subject,
          order.productCode,
          order.goodsName,
          order.timeExpire,
          order.timeExpireMs,
          order.merchantId,
          order.merchantName,
          JSON.stringify(order.lines),
          order.ignoredClientAmountCents,
          order.paymentToken,
          order.pageRedirectionData,
          order.requestFingerprint,
          order.scopeVersion,
          order.confirmationId,
          order.principal,
          order.spendDay,
          order.createdAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findOrder(outTradeNo: string): StoredOrder | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE out_trade_no = ?").get(outTradeNo) as
      | Record<string, unknown>
      | undefined;
    return row ? mapOrder(row) : null;
  }

  /**
   * Write the expense draft once. A repeat with the same trade_no returns the stored draft.
   * Unpaid orders whose scope version no longer matches are left unpaid.
   */
  fulfillOrder(input: {
    outTradeNo: string;
    tradeNo: string;
    expectedAmount: string;
    currentScopeVersion: number;
    activeConfirmationId: string | null;
    createDraft: () => { result: string; expenseDraftId: string; receiptUrl: string; paidAt: string };
  }): { already: boolean; draft: ExpenseDraft } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findOrder(input.outTradeNo);
      if (!existing) throw new Error("order missing");
      if (existing.amount !== input.expectedAmount) throw new Error("amount mismatch");
      if (existing.orderStatus === "TRADE_SUCCESS") {
        if (existing.tradeNo !== input.tradeNo) throw new Error("trade_no mismatch");
        const draft = draftFromOrder(existing);
        if (!draft) throw new Error("fulfilled order has no draft");
        this.db.exec("COMMIT");
        return { already: true, draft };
      }
      if (
        existing.scopeVersion !== input.currentScopeVersion ||
        !input.activeConfirmationId ||
        existing.confirmationId !== input.activeConfirmationId
      ) {
        throw new Error("authorization_changed");
      }
      const owner = this.db
        .prepare("SELECT out_trade_no FROM orders WHERE trade_no = ?")
        .get(input.tradeNo) as { out_trade_no: string } | undefined;
      if (owner && owner.out_trade_no !== input.outTradeNo) throw new Error("trade_no already used");
      const created = input.createDraft();
      const updated = this.db
        .prepare(
          `UPDATE orders
           SET trade_no = ?, order_status = 'TRADE_SUCCESS', service_result = ?,
               expense_draft_id = ?, receipt_url = ?, paid_at = ?
           WHERE out_trade_no = ? AND order_status = 'WAIT_BUYER_PAY'`,
        )
        .run(
          input.tradeNo,
          created.result,
          created.expenseDraftId,
          created.receiptUrl,
          created.paidAt,
          input.outTradeNo,
        );
      if (updated.changes !== 1) throw new Error("order could not be fulfilled");
      this.db.exec("COMMIT");
      const draft = JSON.parse(created.result) as ExpenseDraft;
      return { already: false, draft };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listDrafts(): ExpenseDraft[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE order_status = 'TRADE_SUCCESS' ORDER BY created_at ASC")
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const draft = draftFromOrder(mapOrder(row));
      return draft ? [draft] : [];
    });
  }
}

function mapOrder(row: Record<string, unknown>): StoredOrder {
  return {
    outTradeNo: String(row.out_trade_no),
    amount: String(row.amount),
    amountCents: Number(row.amount_cents),
    subject: String(row.subject),
    productCode: String(row.product_code),
    goodsName: String(row.goods_name),
    timeExpire: String(row.time_expire),
    timeExpireMs: Number(row.time_expire_ms),
    orderStatus: String(row.order_status),
    merchantId: String(row.merchant_id),
    merchantName: String(row.merchant_name),
    lines: JSON.parse(String(row.lines_json)) as OrderLine[],
    ignoredClientAmountCents:
      row.ignored_client_amount_cents == null ? null : Number(row.ignored_client_amount_cents),
    paymentToken: row.payment_token == null ? null : String(row.payment_token),
    pageRedirectionData: String(row.page_redirection_data),
    requestFingerprint: String(row.request_fingerprint),
    scopeVersion: Number(row.scope_version),
    confirmationId: String(row.confirmation_id),
    principal: String(row.principal),
    tradeNo: row.trade_no == null ? null : String(row.trade_no),
    serviceResult: row.service_result == null ? null : String(row.service_result),
    expenseDraftId: row.expense_draft_id == null ? null : String(row.expense_draft_id),
    receiptUrl: row.receipt_url == null ? null : String(row.receipt_url),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    spendDay: String(row.spend_day),
    createdAt: String(row.created_at),
  };
}
