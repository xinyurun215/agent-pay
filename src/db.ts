import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DenyError } from "./errors.js";
import { shanghaiDate } from "./time.js";
import type { Authorization, ExpenseDraft, OrderLine, TokenRecord } from "./types.js";

export interface StoredOrder {
  outTradeNo: string;
  amount: string;
  amountCents: number;
  currency: string;
  resourceId: string;
  goodsName: string;
  payBefore: string;
  payBeforeMs: number;
  orderStatus: string;
  fulfillStatus: string;
  tradeNo: string | null;
  serviceResult: string | null;
  merchantId: string;
  merchantName: string;
  lines: OrderLine[];
  ignoredClientAmountCents: number | null;
  expenseDraftId: string | null;
  receiptUrl: string | null;
  paidAt: string | null;
  paymentToken: string | null;
  paymentNeeded: string;
  spendDay: string;
  createdAt: string;
}

interface OrderInsert {
  outTradeNo: string;
  amount: string;
  amountCents: number;
  currency: string;
  resourceId: string;
  goodsName: string;
  payBefore: string;
  payBeforeMs: number;
  merchantId: string;
  merchantName: string;
  lines: OrderLine[];
  ignoredClientAmountCents: number | null;
  paymentToken: string;
  paymentNeeded: string;
  spendDay: string;
  createdAt: string;
}

interface SpendRow {
  amount_cents: number;
  spend_day: string;
  order_status: string;
  fulfill_status: string;
  pay_before_ms: number;
}

function draftFromOrder(order: StoredOrder): ExpenseDraft | null {
  if (order.fulfillStatus !== "FULFILLED" || !order.serviceResult || !order.expenseDraftId) return null;
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

export class AgentPayDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorization_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        authorized INTEGER NOT NULL,
        payload TEXT
      );
      CREATE TABLE IF NOT EXISTS payment_tokens (
        token TEXT PRIMARY KEY,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL,
        single_use INTEGER NOT NULL,
        used INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        out_trade_no TEXT PRIMARY KEY,
        amount TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        goods_name TEXT NOT NULL,
        pay_before TEXT NOT NULL,
        pay_before_ms INTEGER NOT NULL,
        order_status TEXT NOT NULL,
        fulfill_status TEXT NOT NULL,
        trade_no TEXT,
        service_result TEXT,
        merchant_id TEXT NOT NULL,
        merchant_name TEXT NOT NULL,
        lines_json TEXT NOT NULL,
        ignored_client_amount_cents INTEGER,
        expense_draft_id TEXT,
        receipt_url TEXT,
        paid_at TEXT,
        payment_token TEXT,
        payment_needed TEXT NOT NULL,
        spend_day TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS orders_trade_no
        ON orders(trade_no) WHERE trade_no IS NOT NULL;
    `);
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.db.exec(`
      DELETE FROM orders;
      DELETE FROM payment_tokens;
      DELETE FROM authorization_state;
    `);
  }

  getAuthorization(): { authorized: boolean; authorization: Authorization | null } {
    const row = this.db
      .prepare("SELECT authorized, payload FROM authorization_state WHERE id = 1")
      .get() as { authorized: number; payload: string | null } | undefined;
    if (!row || row.authorized !== 1 || !row.payload) {
      return { authorized: false, authorization: null };
    }
    return { authorized: true, authorization: JSON.parse(row.payload) as Authorization };
  }

  setAuthorization(authorization: Authorization): void {
    this.db
      .prepare(
        `INSERT INTO authorization_state (id, authorized, payload)
         VALUES (1, 1, ?)
         ON CONFLICT(id) DO UPDATE SET authorized = 1, payload = excluded.payload`,
      )
      .run(JSON.stringify(authorization));
  }

  insertToken(token: TokenRecord): void {
    this.db
      .prepare(
        `INSERT INTO payment_tokens (token, issued_at, expires_at, ttl_seconds, single_use, used)
         VALUES (?, ?, ?, ?, 1, 0)`,
      )
      .run(token.token, token.issued_at, token.expires_at, token.ttl_seconds);
  }

  getToken(token: string): TokenRecord | null {
    const row = this.db
      .prepare(
        `SELECT token, issued_at, expires_at, ttl_seconds, single_use, used
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
    };
  }

  spentCents(now: Date): { daily: number; total: number } {
    const day = shanghaiDate(now);
    const nowMs = now.getTime();
    const rows = this.db
      .prepare(
        `SELECT amount_cents, spend_day, order_status, fulfill_status, pay_before_ms FROM orders`,
      )
      .all() as unknown as SpendRow[];
    let daily = 0;
    let total = 0;
    for (const row of rows) {
      const unpaid = row.order_status === "PENDING_PAYMENT" && row.fulfill_status === "UNFULFILLED";
      if (unpaid && row.pay_before_ms <= nowMs) continue;
      total += row.amount_cents;
      if (row.spend_day === day) daily += row.amount_cents;
    }
    return { daily, total };
  }

  consumeTokenAndCreateOrder(token: string, order: OrderInsert): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db
        .prepare("UPDATE payment_tokens SET used = 1 WHERE token = ? AND used = 0")
        .run(token);
      if (updated.changes !== 1) {
        throw new DenyError("token_reused", "Payment token is single-use and has already been consumed");
      }
      this.db
        .prepare(
          `INSERT INTO orders (
             out_trade_no, amount, amount_cents, currency, resource_id, goods_name,
             pay_before, pay_before_ms, order_status, fulfill_status, merchant_id,
             merchant_name, lines_json, ignored_client_amount_cents, payment_token,
             payment_needed, spend_day, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', 'UNFULFILLED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order.outTradeNo,
          order.amount,
          order.amountCents,
          order.currency,
          order.resourceId,
          order.goodsName,
          order.payBefore,
          order.payBeforeMs,
          order.merchantId,
          order.merchantName,
          JSON.stringify(order.lines),
          order.ignoredClientAmountCents,
          order.paymentToken,
          order.paymentNeeded,
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

  findOrderByDraft(draftId: string): StoredOrder | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE expense_draft_id = ?").get(draftId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapOrder(row) : null;
  }

  prepareFulfillment(input: {
    outTradeNo: string;
    tradeNo: string;
    expectedAmount: string;
    expectedResourceId: string;
    createResource: () => { result: string; expenseDraftId: string; receiptUrl: string; paidAt: string };
  }): { state: "PENDING_CONFIRM" | "FULFILLED"; serviceResult: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findOrder(input.outTradeNo);
      if (!existing) {
        throw new Error("order missing during fulfillment");
      }
      if (existing.fulfillStatus === "FULFILLED" || existing.fulfillStatus === "PENDING_CONFIRM") {
        if (existing.serviceResult && existing.tradeNo === input.tradeNo) {
          this.db.exec("COMMIT");
          return {
            state: existing.fulfillStatus,
            serviceResult: existing.serviceResult,
          };
        }
        throw new Error("trade_no does not match the in-progress order");
      }
      const owner = this.db
        .prepare("SELECT out_trade_no FROM orders WHERE trade_no = ?")
        .get(input.tradeNo) as { out_trade_no: string } | undefined;
      if (owner && owner.out_trade_no !== input.outTradeNo) {
        throw new Error("trade_no already fulfilled");
      }
      if (existing.amount !== input.expectedAmount || existing.resourceId !== input.expectedResourceId) {
        throw new Error("fulfillment preconditions failed");
      }
      const created = input.createResource();
      const updated = this.db
        .prepare(
          `UPDATE orders
           SET trade_no = ?, order_status = 'PAID', fulfill_status = 'PENDING_CONFIRM',
               service_result = ?, expense_draft_id = ?, receipt_url = ?, paid_at = ?
           WHERE out_trade_no = ? AND fulfill_status = 'UNFULFILLED'`,
        )
        .run(
          input.tradeNo,
          created.result,
          created.expenseDraftId,
          created.receiptUrl,
          created.paidAt,
          input.outTradeNo,
        );
      if (updated.changes !== 1) {
        throw new Error("order could not enter fulfillment");
      }
      this.db.exec("COMMIT");
      return { state: "PENDING_CONFIRM", serviceResult: created.result };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markFulfilled(outTradeNo: string, tradeNo: string): void {
    const updated = this.db
      .prepare(
        `UPDATE orders SET fulfill_status = 'FULFILLED', order_status = 'PAID'
         WHERE out_trade_no = ? AND trade_no = ? AND fulfill_status = 'PENDING_CONFIRM'`,
      )
      .run(outTradeNo, tradeNo);
    if (updated.changes !== 1) {
      const current = this.findOrder(outTradeNo);
      if (current?.fulfillStatus === "FULFILLED" && current.tradeNo === tradeNo) return;
      throw new Error("order could not be marked fulfilled");
    }
  }

  listDrafts(): ExpenseDraft[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE fulfill_status = 'FULFILLED' ORDER BY created_at ASC")
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
    currency: String(row.currency),
    resourceId: String(row.resource_id),
    goodsName: String(row.goods_name),
    payBefore: String(row.pay_before),
    payBeforeMs: Number(row.pay_before_ms),
    orderStatus: String(row.order_status),
    fulfillStatus: String(row.fulfill_status),
    tradeNo: row.trade_no == null ? null : String(row.trade_no),
    serviceResult: row.service_result == null ? null : String(row.service_result),
    merchantId: String(row.merchant_id),
    merchantName: String(row.merchant_name),
    lines: JSON.parse(String(row.lines_json)) as OrderLine[],
    ignoredClientAmountCents:
      row.ignored_client_amount_cents == null ? null : Number(row.ignored_client_amount_cents),
    expenseDraftId: row.expense_draft_id == null ? null : String(row.expense_draft_id),
    receiptUrl: row.receipt_url == null ? null : String(row.receipt_url),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    paymentToken: row.payment_token == null ? null : String(row.payment_token),
    paymentNeeded: String(row.payment_needed),
    spendDay: String(row.spend_day),
    createdAt: String(row.created_at),
  };
}
