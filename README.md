# Agent Pay · 办公文具采购

Office agent checkout for desktop stationery (签字笔 / A4纸 / 文件夹) from merchant `stationery-demo-001`. The user sets a budget, merchant whitelist, and validity window. Only then can the agent take a 300-second single-use payment token.

Payment itself is **not** a private protocol. A passing authorization creates an [AI 按量付费](https://aipay.alipay.com/docs/ai-receive/MACHINE_PAY.md) bill: HTTP 402 plus a Base64URL `Payment-Needed` header, signed locally with the merchant PKCS#1 key. The agent pays that bill in the Alipay sandbox, then retries with `Payment-Proof`. This service calls `alipay.aipay.agent.payment.verify` and `alipay.aipay.agent.fulfillment.confirm` through `alipay-sdk`. The expense draft is written only after verification matches the server price.

No production Alipay credentials are required. Sandbox `service_id` stays `api_mock_service_id`.

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
    "payment_token": { "ttl_seconds": 300, "single_use": true }
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

`payment_token.ttl_seconds` and `single_use` are fixed. Amounts are integer cents. The only payable product merchant is `stationery-demo-001`, and it must be on the whitelist. A SKU is allowed when its catalog name contains one `sku_keywords` entry. The Alipay seller id is the sandbox 2088 account inside `.alipay-sandbox.json`; it is not the product merchant id. Receipt `merchant_name` is `文具演示商户`.

## Install the official skill

```bash
npx -y @alipay/alipay-aipay@latest install
```

That skill covers three products. This MVP uses **AI 按量付费** (Agent Pay / 402 / A2M):

- No `Payment-Proof`: respond `402` with `Payment-Needed` (`out_trade_no`, `amount`, `currency=CNY`, `resource_id`, `pay_before`, `seller_signature`, `seller_sign_type=RSA2`, `seller_unique_id`, plus method `seller_id`, `seller_app_id`, `goods_name`, `service_id`).
- With `Payment-Proof`: `alipay.aipay.agent.payment.verify`, then `alipay.aipay.agent.fulfillment.confirm`.
- Sandbox gateway `https://openapi-sandbox.dl.alipaydev.com/gateway.do`.
- Sandbox `service_id=api_mock_service_id` (do not use it in production).
- Node.js reads `appPrivatePkcsKey` (PKCS#1). Do not add PEM headers.

Quick sandbox on Linux, from the installed skill directory:

```bash
node "<SKILL_DIR>/references/normal/scripts/runtime.mjs" sandbox ensure "<project path>" "Node.js" --agent-platform "Cursor" --session-id "<SESSION_ID>"
```

`SESSION_ID` comes from the skill's `telemetry resolve-session` command. A ready run writes `/.alipay-sandbox.json` with mode `0600`. That file is gitignored and must stay out of git. Do not paste private keys, buyer passwords, or `Payment-Proof` values into the README, logs, or commits.

Live cashier completion, after this server is up and a token exists, uses the skill's A2M runner (`a2m run --auto-complete --require-payment-validation`) against `POST /agent/purchase`. The buyer id is the sandbox buyer's `userId` from the local config. The runner posts the original JSON body, reads `Payment-Needed`, pays at the sandbox cashier, and retries with `Payment-Proof`.

## Run

Node.js 22+.

```bash
npm install
ADMIN_TOKEN=choose-a-local-secret npm start
```

Open http://127.0.0.1:3000 and paste that same value into the Admin token field. The page sends it as `Authorization: Bearer` and keeps it in this tab's sessionStorage. `PUT /authorization`, `POST /payment-tokens`, `POST /sandbox/clock`, and `POST /sandbox/reset` return `401` `unauthorized` without that bearer. An empty `ADMIN_TOKEN` rejects every one of those calls. Orders live in `data/agent-pay.sqlite` (gitignored). `POST /sandbox/reset` clears authorization, tokens, and orders. It does not delete `.alipay-sandbox.json`.

```bash
npm test
npm run typecheck
```

`npm test` does not call Alipay. It drives the same verify and confirm method names through a scripted `alipay-sdk` executor, and it checks the merchant RSA2 signature on `Payment-Needed`. A verify response is accepted only when `alipay.aipay.agent.payment.verify` itself returns `active`, `amount`, `trade_no`, `out_trade_no`, and `resource_id`. Missing fields do not fall back to the local order, and no expense draft is written.

## Catalog

| SKU | Name | Unit price |
| --- | --- | --- |
| `sku-pen` | 黑色签字笔 | 800 cents (`8.00` CNY) |
| `sku-pen-cent` | 签字笔（1分试买） | 1 cent (`0.01` CNY) |
| `sku-paper` | A4纸 70g 500张 | 2500 cents |
| `sku-folder` | 资料文件夹 | 1200 cents |
| `sku-mug` | 陶瓷马克杯 | 3900 cents (keyword miss) |

## Demo: happy path

```bash
BASE=http://127.0.0.1:3000
AUTH="authorization: Bearer $ADMIN_TOKEN"

curl -s -X POST $BASE/sandbox/clock \
  -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"now":"2026-10-09T10:00:00+08:00"}'

curl -s -X PUT $BASE/authorization \
  -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{
    "budget": {"per_order_cents": 50000, "daily_cents": 200000, "total_cents": 500000},
    "valid_from": "2026-10-09T00:00:00+08:00",
    "valid_to": "2026-10-16T23:59:59+08:00",
    "merchant_whitelist": ["stationery-demo-001"]
  }'

TOKEN=$(curl -s -X POST $BASE/payment-tokens -H "$AUTH" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")

curl -sD - -X POST $BASE/agent/purchase \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-pen\",\"quantity\":1}],\"amount_cents\":1}"
```

Before `PUT /authorization`, token issuance returns `403` `authorization_required`.

The purchase response is HTTP 402. Body `amount` is `8.00` and `amount_cents` is `800`, not the client value `1`. The `Payment-Needed` header is the bill the sandbox cashier pays. A second purchase with the same token and no `Payment-Proof` returns `token_reused`.

`sku-pen-cent` is the 1-fen demo. One unit bills `amount` `0.01` and `amount_cents` `1`. Its name contains `签字笔`, so the default keyword list allows it.

After a `Payment-Proof` verifies, `GET /expense-drafts` contains `order_id`, `amount_cents`, `paid_at`, `merchant_name`, `receipt_url`, and `expense_draft_id`. Open `receipt_url` for the receipt. If `alipay.aipay.agent.fulfillment.confirm` fails, the draft is not listed; retry the same `Payment-Proof`.

Change `budget` or the validity window with `PUT /authorization` before issuing a token. Pending unpaid bills reserve budget until `pay_before` (30 minutes). Fulfilled payments keep counting.

## Demo: deny reasons

Checks before a bill is signed: token TTL, authorization window, single-use, merchant, SKU keywords, then budget (per order, Asia/Shanghai day, total). A deny does not consume the token and does not call Alipay. Set the clock and authorization as in the happy path, then issue a token.

### `over_budget`

63 × `sku-pen` is 50400 cents, above the default per-order cap of 50000.

```bash
curl -s -X POST $BASE/agent/purchase \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-pen\",\"quantity\":63}]}"
```

The same code is returned when the charge would exceed `daily_cents` or `total_cents`. `limit` is `per_order`, `daily`, or `total`.

### `merchant_not_allowed`

```bash
curl -s -X POST $BASE/agent/purchase \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"cafe-demo-009\",\"items\":[{\"sku_id\":\"sku-pen\",\"quantity\":1}]}"
```

Paying `stationery-demo-001` after removing it from the whitelist is the same code. Whitelisting another merchant does not make that merchant payable.

### `expired`

Move the clock to one second after the token `expires_at` and purchase. The same code is returned when `now` is outside `valid_from` / `valid_to`, including token issuance.

```bash
curl -s -X POST $BASE/sandbox/clock \
  -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"now":"2026-10-09T10:05:01+08:00"}'
```

`{"reset": true}` returns to the system clock.

### `token_reused`

Create a 402 bill, then `POST /agent/purchase` again with the same token and no `Payment-Proof`.

### `sku_not_allowed`

```bash
curl -s -X POST $BASE/agent/purchase \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-mug\",\"quantity\":1}]}"
```

Unknown `sku_id` values return the same code.

## API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/health` | Rail name, whether sandbox config is loaded, `deny_reasons` |
| `GET` | `/catalog` | Authoritative SKU prices |
| `GET` | `/authorization` | Current authorization and defaults |
| `PUT` | `/authorization` | Set budget, whitelist, and validity. Requires admin bearer |
| `POST` | `/payment-tokens` | Issue a token after authorization. Requires admin bearer |
| `GET` | `/payment-tokens/:token` | Token status, including `used` |
| `POST` | `/agent/purchase` | 402 `Payment-Needed`, or verify `Payment-Proof` |
| `GET` | `/orders/:orderId` | Fulfilled order |
| `GET` | `/expense-drafts` | Receipt callbacks |
| `GET` | `/expense-drafts/:id` | One draft |
| `GET` | `/receipts/:orderId` | HTML receipt |
| `GET` | `/sandbox/clock` | Read the demo clock |
| `POST` | `/sandbox/clock` | Set the demo clock. Requires admin bearer |
| `POST` | `/sandbox/reset` | Clear authorization, tokens, and orders. Requires admin bearer |

Denied purchases respond with HTTP 403:

```json
{ "ok": false, "deny_reason": "over_budget", "message": "..." }
```
