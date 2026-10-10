# Agent Pay · 办公文具采购

Office agent checkout for desktop stationery (签字笔 / A4纸 / 文件夹) from merchant `stationery-demo-001`. The user saves a budget, merchant whitelist, and validity window, then confirms that scope. Only then can the agent take a 300-second single-use payment token.

This demo is **商品 Agent Pay** (办公智能体支付) on the PC merchant path from the official docs:

- https://aipay.alipay.com/docs/agent-pay/skillpay.html
- https://aipay.alipay.com/products/office-agent-pay.md

Checkout calls `alipay.trade.page.pay` (`product_code=FAST_INSTANT_TRADE_PAY`) through `alipay-sdk` `pageExecute` GET. The response body is `pageRedirectionData`, a sandbox cashier URL. The official next commands are `alipay-bot trigger-payment-signal` and `alipay-bot submit-payment`. This service does not run those commands and does not pay on the user's behalf.

What this repo has verified is the signed cashier URL, plus local tests that simulate `alipay.trade.query` and the async notify. `alipay-bot submit-payment` has not been run, so there is no completed sandbox payment and no expense draft produced by a live Alipay trade.

When a matching paid proof is supplied, `alipay.trade.query` or a signed notify must match the stored order amount and `out_trade_no` before an expense draft is written. A signed notify for an unpaid order whose authorization later changed is answered `success` and still writes no draft.

Sandbox only. A non-sandbox gateway is refused.

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

`payment_token.ttl_seconds` and `single_use` are fixed. Amounts are integer cents. The only payable product merchant is `stationery-demo-001`, and it must be on the whitelist. A SKU is allowed when its catalog name contains one `sku_keywords` entry. Receipt `merchant_name` is `文具演示商户`.

User confirmation is separate from the admin token. `POST /authorization/confirm` requires `X-User-Authorization: Bearer $USER_TOKEN` and records:

- `principal` — the server subject bound to that user token. It comes from `DEMO_PRINCIPAL`, or `demo:office-user` when that variable is unset. A request body that includes `principal` returns `400` `principal_not_accepted`.
- `scope` and `scope_version` — the saved policy; saving again bumps the version and revokes the confirmation
- `confirmed_at`
- `revocable: true` — `POST /authorization/revoke` sets `revoked_at`
- an append-only audit list at `GET /authorization/audit`

Confirmation, audit events, and orders store that server principal. `ADMIN_TOKEN` cannot confirm or revoke. The two secrets must differ.

## Install the official skill

```bash
npx -y @alipay/agent-payment@latest install
```

That installs the 商品 / 办公 Agent Pay skill and the `alipay-bot` command. Follow the skill's sandbox setup so `.alipay-sandbox.json` exists beside this project (mode `0600`, gitignored). Node reads `appPrivatePkcsKey` (PKCS#1). Do not add PEM headers. Do not paste private keys, buyer passwords, or notify payloads into the README, logs, or commits.

## Run

Node.js 22+.

```bash
npm install
ADMIN_TOKEN=choose-an-admin-secret USER_TOKEN=choose-a-different-user-secret npm start
```

`DEMO_PRINCIPAL` is optional. Leave it unset to bind the user token to `demo:office-user`.

Open http://127.0.0.1:3000. Paste the two secrets into the Admin token and User token fields. The page keeps them in this tab's sessionStorage. The principal line is filled from the server. There is no principal input.

`PUT /authorization`, `POST /payment-tokens`, `POST /sandbox/clock`, `POST /sandbox/reset`, `POST /agent/orders/:id/confirm`, and the sensitive reads (`GET /authorization`, `/authorization/audit`, `/payment-tokens/:token`, `/orders/:id`, `/expense-drafts`, `/receipts/:id`) return `401` without the admin bearer. An empty `ADMIN_TOKEN` rejects every one of those calls.

Orders live in `data/agent-pay.sqlite` (gitignored). `POST /sandbox/reset` clears authorization, confirmation, tokens, orders, and the audit log. It does not delete `.alipay-sandbox.json`.

```bash
npm test
npm run typecheck
```

`npm test` does not call Alipay and does not run `alipay-bot`. Page-pay URLs are produced by the real `alipay-sdk` `pageExecute` with an ephemeral key. `alipay.trade.query` and notify signature checks go through a class marked `TEST DOUBLE` in `tests/acceptance.test.ts`. That double is not a completed payment. The demo process does not use that class.

## Catalog

| SKU | Name | Unit price |
| --- | --- | --- |
| `sku-pen` | 黑色签字笔 | 800 cents (`8.00` CNY) |
| `sku-pen-cent` | 签字笔（1分试买） | 1 cent (`0.01` CNY) |
| `sku-paper` | A4纸 70g 500张 | 2500 cents |
| `sku-folder` | 资料文件夹 | 1200 cents |
| `sku-mug` | 陶瓷马克杯 | 3900 cents (keyword miss) |

`sku-pen-cent` is the 1-fen demo. Its name contains `签字笔`, so the default keyword list allows it.

## Demo: happy path

```bash
BASE=http://127.0.0.1:3000
AUTH="authorization: Bearer $ADMIN_TOKEN"
USER="x-user-authorization: Bearer $USER_TOKEN"

curl -s -X POST $BASE/sandbox/clock \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"now":"2026-10-09T10:00:00+08:00"}'

curl -s -X PUT $BASE/authorization \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "budget": {"per_order_cents": 50000, "daily_cents": 200000, "total_cents": 500000},
    "valid_from": "2026-10-09T00:00:00+08:00",
    "valid_to": "2026-10-16T23:59:59+08:00",
    "merchant_whitelist": ["stationery-demo-001"]
  }'

curl -s -X POST $BASE/authorization/confirm \
  -H "$USER" -H 'content-type: application/json' \
  -d '{}'

TOKEN=$(curl -s -X POST $BASE/payment-tokens -H "$AUTH" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")

curl -s -X POST $BASE/agent/purchase \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"merchant_id\":\"stationery-demo-001\",\"items\":[{\"sku_id\":\"sku-pen-cent\",\"quantity\":1}],\"amount_cents\":1}"
```

Before the policy is saved, token issuance returns `403` `authorization_required`. After it is saved but before user confirmation, it returns `403` `user_confirmation_required`.

The purchase response is HTTP 200. For one `sku-pen`, `total_amount` is `8.00` and `amount_cents` is `800`, not a client-supplied `1`. For one `sku-pen-cent`, `total_amount` is `0.01`. `page_redirection_data` is the cashier URL (`method=alipay.trade.page.pay`). A second purchase with the same token returns `token_reused`. No expense draft exists yet.

The official handoff is below. This repository's recorded verification has not run it. `scripts/sandbox-evidence.mjs` is the sandbox-only way to run it and keep the outputs on disk.

```bash
alipay-bot trigger-payment-signal \
  --payment-link "<page_redirection_data>" \
  --merchant-info "<文具演示商户，商品名称，金额（元）>" \
  --amount "<total_amount>"

alipay-bot submit-payment \
  --payment-link "<short link from trigger-payment-signal>" \
  --intent-summary "<文具演示商户，商品名称，金额（元）>"
```

`POST /agent/orders/<out_trade_no>/confirm` then calls `alipay.trade.query`. A draft is written only when that response, or a signed notify, reports a matching paid trade. Automated tests stub that response. They do not pay at the sandbox cashier. A second confirm of a draft that was already written returns the same draft.

```bash
curl -s -X POST $BASE/agent/orders/<out_trade_no>/confirm -H "$AUTH"
```

If a live paid trade has been queried, `GET /expense-drafts` contains `order_id`, `amount_cents`, `paid_at`, `merchant_name`, `receipt_url`, and `expense_draft_id`. If Alipay can reach this process, it can also POST `application/x-www-form-urlencoded` to `/alipay/notify`. The body is accepted only when `alipay-sdk` `checkNotifySign` succeeds.

Saving the policy again bumps `scope_version`, revokes the confirmation, and makes `POST /agent/orders/:id/confirm` return `409` `authorization_changed` for the old unpaid order. A signed async notify for that same order returns the plain text `success` and does not write a draft.

## Sandbox evidence path

`scripts/sandbox-evidence.mjs` is a local sandbox cashier walkthrough for one `sku-pen-cent` (`0.01` CNY). It checks that `.alipay-sandbox.json` exists and that this server's health reports the sandbox page.pay rail, then saves the policy, confirms with an empty body, creates the cashier URL, and runs `alipay-bot trigger-payment-signal` and `alipay-bot submit-payment`. It then calls `POST /agent/orders/:id/confirm` and writes:

```text
artifacts/sandbox/<timestamp>/
  cashier-url.txt
  purchase.json
  trigger-payment-signal.json
  submit-payment.json
  trade-query.json
  expense-draft.json
  manifest.json
```

`artifacts/` is gitignored. The cashier file is a signed sandbox URL. Keep it local.

```bash
ADMIN_TOKEN=... USER_TOKEN=... node scripts/sandbox-evidence.mjs
```

The server must already be listening, started with the same two tokens. The script refuses to continue when `ALIPAY_GATEWAY` is set to anything other than the sandbox gateway. A successful run is sandbox cashier evidence for 1 fen. It is not a production charge and it is not evidence that real funds moved. This repository's current verification has not run the script, so the default statement stands: `alipay-bot submit-payment` has not been run here.

## Demo: deny reasons

Checks before a cashier URL is signed: token TTL, authorization window, single-use, user confirmation still active, merchant, SKU keywords, then budget (per order, Asia/Shanghai day, total). A deny does not consume the token and does not call Alipay. Set the clock, authorization, and user confirmation as in the happy path, then issue a token.

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
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"now":"2026-10-09T10:05:01+08:00"}'
```

`{"reset": true}` returns to the system clock.

### `token_reused`

Create a cashier URL, then `POST /agent/purchase` again with the same token.

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
| `GET` | `/health` | Rail `alipay.trade.page.pay`, product `office-agent-pay`, `deny_reasons` |
| `GET` | `/catalog` | Authoritative SKU prices |
| `GET` | `/authorization/defaults` | Published default scope, no saved policy |
| `GET` | `/authorization` | Saved scope, version, and confirmation. Admin bearer |
| `PUT` | `/authorization` | Set budget, whitelist, and validity. Admin bearer. Bumps `scope_version` |
| `POST` | `/authorization/confirm` | User confirms the current scope. User bearer. Principal is `DEMO_PRINCIPAL`. A body field `principal` returns `400` `principal_not_accepted` |
| `POST` | `/authorization/revoke` | User revokes the confirmation. User bearer |
| `GET` | `/authorization/audit` | Confirm, revoke, token, order, and fulfill events. Admin bearer |
| `POST` | `/payment-tokens` | Issue a token after user confirmation. Admin bearer |
| `GET` | `/payment-tokens/:token` | Token status. Admin bearer |
| `POST` | `/agent/purchase` | Create the `page.pay` cashier URL |
| `POST` | `/agent/orders/:id/confirm` | `alipay.trade.query`, then the expense draft. Admin bearer |
| `POST` | `/alipay/notify` | Signed Alipay notify. `success` after fulfill, on a repeat, or when the unpaid order's authorization changed. `failure` otherwise. No draft in the changed-authorization case |
| `GET` | `/orders/:orderId` | Fulfilled order. Admin bearer |
| `GET` | `/expense-drafts` | Receipt callbacks. Admin bearer |
| `GET` | `/expense-drafts/:id` | One draft. Admin bearer |
| `GET` | `/receipts/:orderId` | HTML receipt. Admin bearer |
| `GET` | `/sandbox/clock` | Read the demo clock |
| `POST` | `/sandbox/clock` | Set the demo clock. Admin bearer |
| `POST` | `/sandbox/reset` | Clear authorization, confirmation, tokens, orders, and audit. Admin bearer |

Denied purchases respond with HTTP 403:

```json
{ "ok": false, "deny_reason": "over_budget", "message": "..." }
```

## What was verified

- Local `pageExecute` cashier URL for `alipay.trade.page.pay`, including `sku-pen-cent` at `0.01` CNY. The browser demo showed that URL. It did not open the cashier.
- User confirmation, the five deny reasons, and admin bearer checks.
- Simulated `alipay.trade.query` and notify inside `npm test`. The trade payload comes from a test double.

## Not verified

- `alipay-bot trigger-payment-signal` and `alipay-bot submit-payment` were not run for this revision, and `scripts/sandbox-evidence.mjs` was not executed. There is no sandbox cashier evidence directory in this verification, no completed Agent Pay payment loop, and no expense draft produced by Alipay. Running that script later would record sandbox cashier evidence only. It would not show a real-fund deduction.
- APP `alipay.trade.order.prepay` is deferred and not wired.
- A live notify delivery needs a URL Alipay can reach. After an authorization change, a signed notify for the old unpaid order is answered `success` and writes no draft.
