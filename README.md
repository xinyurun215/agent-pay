# Agent Pay · 办公文具采购沙箱

Local sandbox for an office agent that buys desktop stationery (签字笔 / A4纸 / 文件夹) from merchant `stationery-demo-001`. The user sets a budget, merchant whitelist, and validity window. Only then can the agent obtain a 300-second single-use payment token, pay at server-authoritative catalog prices, and receive a structured expense draft.

This process does not call Alipay and does not move real money.

## Authorization schema

```json
{
  "authorization": {
    "budget": {
      "per_order_cents": 50000,
      "daily_cents": 200000,
      "total_cents": 500000
    },
    "valid_from": "2026-10-09T00:00:00+08:00",
    "valid_to": "2026-10-16T23:59:59+08:00",
    "merchant_whitelist": ["stationery-demo-001"],
    "category": "desktop_stationery",
    "sku_keywords": ["签字笔", "A4纸", "文件夹"],
    "payment_token": {
      "ttl_seconds": 300,
      "single_use": true
    }
  },
  "receipt_callback": {
    "order_id": "string",
    "amount_cents": "number",
    "paid_at": "datetime",
    "merchant_name": "string",
    "receipt_url": "string",
    "expense_draft_id": "string?"
  },
  "deny_reasons": ["over_budget", "merchant_not_allowed", "expired", "token_reused", "sku_not_allowed"]
}
```

`payment_token.ttl_seconds` and `single_use` are fixed by the server. A client that sends other values still receives a 300-second single-use token.

Amounts are integer cents. The only payable merchant is `stationery-demo-001`, and it must also appear in the whitelist. A SKU is allowed when its catalog name contains one of `sku_keywords` as a substring.

## Run

Requires Node.js 22+.

```bash
npm install
npm start
```

Open http://127.0.0.1:3000.

The page can save the default authorization, issue a token, pay, and trigger each deny reason. Use **沙箱时间设为 2026-10-09 10:00 +08** when the machine clock is outside the sample validity window. State is in memory and resets when the process restarts. `POST /sandbox/reset` clears it immediately.

```bash
npm test
npm run typecheck
```

## Catalog (server prices)

| SKU | Name | Unit price |
| --- | --- | --- |
| `sku-pen` | 黑色签字笔 | 800 cents |
| `sku-paper` | A4纸 70g 500张 | 2500 cents |
| `sku-folder` | 资料文件夹 | 1200 cents |
| `sku-mug` | 陶瓷马克杯 | 3900 cents (keyword miss, for `sku_not_allowed`) |

`文具演示商户` is the receipt `merchant_name` for `stationery-demo-001`.

## Demo: happy path

```bash
BASE=http://127.0.0.1:3000

curl -s -X POST $BASE/sandbox/clock \
  -H 'content-type: application/json' \
  -d '{"now":"2026-10-09T10:00:00+08:00"}'

curl -s -X PUT $BASE/authorization \
  -H 'content-type: application/json' \
  -d '{
    "budget": {"per_order_cents": 50000, "daily_cents": 200000, "total_cents": 500000},
    "valid_from": "2026-10-09T00:00:00+08:00",
    "valid_to": "2026-10-16T23:59:59+08:00",
    "merchant_whitelist": ["stationery-demo-001"],
    "category": "desktop_stationery",
    "sku_keywords": ["签字笔", "A4纸", "文件夹"]
  }'

TOKEN=$(curl -s -X POST $BASE/payment-tokens | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")

curl -s -X POST $BASE/payments \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-pen\",\"quantity\":1}],\"amount_cents\":1}"

curl -s $BASE/expense-drafts
```

Before the `PUT`, `POST /payment-tokens` returns `403` and `authorization_required`.

The payment response `amount_cents` is `800`, not the client-supplied `1`. The same object is stored as the expense draft:

- `order_id`
- `amount_cents`
- `paid_at`
- `merchant_name`
- `receipt_url`
- `expense_draft_id`

Open `receipt_url` for the human-readable receipt. A second charge with the same token returns `token_reused`.

Change `budget` or `valid_from` / `valid_to` on `PUT /authorization` before issuing a token. The new limits apply to later payments. Existing spend still counts toward the daily and total caps.

## Demo: deny reasons

Checks run in this order: token TTL, authorization window, single-use, merchant, SKU keywords, then budget (per order, then the Asia/Shanghai calendar day, then the total). A denied attempt does not consume the token. A successful payment does.

Set the clock and authorization as in the happy path, then:

### `over_budget`

63 × `sku-pen` is 50400 cents, above the default per-order cap of 50000.

```bash
curl -s -X POST $BASE/payments \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-pen\",\"quantity\":63}]}"
```

The same code is returned when the charge would exceed `daily_cents` or `total_cents`. The `limit` field is `per_order`, `daily`, or `total`.

### `merchant_not_allowed`

```bash
curl -s -X POST $BASE/payments \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"cafe-demo-009\",\"items\":[{\"sku_id\":\"sku-pen\",\"quantity\":1}]}"
```

Paying `stationery-demo-001` after removing it from `merchant_whitelist` is the same code. Adding any other merchant to the whitelist does not make that merchant payable.

### `expired`

Move the sandbox clock to one second after the token's `expires_at` (still inside the authorization window) and pay:

```bash
curl -s -X POST $BASE/sandbox/clock \
  -H 'content-type: application/json' \
  -d '{"now":"2026-10-09T10:05:01+08:00"}'
```

The same code is returned when `now` is outside `valid_from` / `valid_to`, including token issuance. `POST /sandbox/clock` with `{"reset": true}` returns to the system clock.

### `token_reused`

Pay once successfully, then `POST /payments` again with the same token.

### `sku_not_allowed`

```bash
curl -s -X POST $BASE/payments \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-mug\",\"quantity\":1}]}"
```

Unknown `sku_id` values return the same code. Names match by substring, so `黑色签字笔` matches `签字笔`.

## API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/health` | Service name and `deny_reasons` |
| `GET` | `/catalog` | Merchant and authoritative SKU prices |
| `GET` | `/authorization` | Current authorization, defaults, deny reasons |
| `PUT` | `/authorization` | Set budget, whitelist, and validity |
| `POST` | `/payment-tokens` | Issue a token after authorization |
| `GET` | `/payment-tokens/:token` | Token status, including `used` |
| `POST` | `/payments` | Sandbox pay |
| `GET` | `/orders/:orderId` | Paid order and line items |
| `GET` | `/expense-drafts` | Receipt callbacks written so far |
| `GET` | `/expense-drafts/:id` | One draft |
| `GET` | `/receipts/:orderId` | HTML receipt (`Accept: application/json` for JSON) |
| `GET` | `/sandbox/clock` | Current instant |
| `POST` | `/sandbox/clock` | `{ "now": "<iso>" }` or `{ "reset": true }` |
| `POST` | `/sandbox/reset` | Clear authorization, tokens, orders, and the clock |

Denied payments respond with HTTP 403:

```json
{ "ok": false, "deny_reason": "over_budget", "message": "..." }
```

## Tests

`npm test` covers:

- no token until authorization is saved
- token TTL of 300 seconds and `single_use: true`
- successful pay, server amount, and expense draft fields
- client `amount_cents` ignored, including a value above the budget
- all five deny reasons, plus daily and total budget caps
- token remains unused after a deny and is consumed after success
