import type { OrderLine } from "./types.js";

export interface ReceiptView {
  order_id: string;
  merchant_id: string;
  merchant_name: string;
  lines: OrderLine[];
  amount_cents: number;
  paid_at: string;
  expense_draft_id: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function renderReceipt(order: ReceiptView): string {
  const rows = order.lines
    .map(
      (line) => `<tr>
        <td>${escapeHtml(line.name)}</td>
        <td>${escapeHtml(line.sku_id)}</td>
        <td>${line.quantity}</td>
        <td>${line.unit_price_cents}</td>
        <td>${line.line_cents}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>收据 ${escapeHtml(order.order_id)}</title>
  <style>
    body { font-family: "Songti SC", "Noto Serif SC", Palatino, serif; margin: 2rem auto; max-width: 40rem; color: #1f1a14; background: #f7f4ee; }
    main { background: white; padding: 1.5rem 1.75rem 2rem; border: 1px solid #e4dccb; }
    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    p { margin: 0.2rem 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.4rem 0.3rem; border-bottom: 1px solid #eee; font-variant-numeric: tabular-nums; }
    .stamp { float: right; border: 2px solid #c23a2e; color: #c23a2e; padding: 0.35rem 0.5rem; font-weight: 700; letter-spacing: 0.08em; }
    a { color: #8c2f26; }
  </style>
</head>
<body>
  <main>
    <div class="stamp">SANDBOX</div>
    <h1>办公文具支付收据</h1>
    <p>商户 ${escapeHtml(order.merchant_name)}（${escapeHtml(order.merchant_id)}）</p>
    <p>订单号 <strong>${escapeHtml(order.order_id)}</strong></p>
    <p>支付时间 ${escapeHtml(order.paid_at)}</p>
    <p>报销草稿 ${escapeHtml(order.expense_draft_id)}</p>
    <table>
      <thead><tr><th>商品</th><th>SKU</th><th>数量</th><th>单价（分）</th><th>小计（分）</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p><strong>实付 ${order.amount_cents} 分（¥${yuan(order.amount_cents)}）</strong></p>
    <p>金额以服务端目录价为准。</p>
    <p><a href="/">返回演示台</a></p>
  </main>
</body>
</html>`;
}
