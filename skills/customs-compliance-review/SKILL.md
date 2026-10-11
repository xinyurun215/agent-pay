---
name: customs-compliance-review
description: 审查一票进出口申报字段，返回禁限关键词、HS/税码风险和缺失栏位。未付款只给数量，买断交付明文，周期付费只消耗当期调用次数。
---

# 报关合规审查

对一票货物的申报字段做确定性审查。规则在本地运行，不调用大模型。

## 何时使用

用户要看一票货能不能报关：有没有禁限关键词、HS 或税收分类编码是否异常、还缺哪些栏位。

## 调用

向本机服务发送：

```http
POST /api/skill/review
Content-Type: application/json

{
  "buyerId": "买家标识",
  "declaration": {
    "direction": "export",
    "goodsName": "商品名称",
    "hsCode": "10位编码"
  }
}
```

`buyerId` 是演示用的买家标识，不是登录凭证。

## 交付

服务先审查，再按权益决定给多少内容。

- 没有有效权益：`delivery` 为 `locked`。只返回风险等级和命中数量，不返回关键词、税号原因、缺失栏位，也不返回 Skill 明文。
- 买断：`delivery` 为 `buyout_plaintext`。返回完整审查结果和 Skill 明文，并写入可再次下载的存档。
- 周期：`delivery` 为 `subscription_call`。返回这一次的审查结果，调用次数减一。不返回 Skill 明文，不写入可下载存档。到期或不剩次数后，下一次调用重新锁定。周期不自动续费。

明文下载：

```http
GET /api/pay/orders/{orderId}/plaintext?buyerId={buyerId}
```

周期订单返回 `PLAINTEXT_WITHHELD`。

## 收款

先把档位、金额和交付范围告诉用户，等用户本人确认后再下单。不要替用户确认支付。

```http
POST /api/pay/checkout
{"buyerId":"买家标识","tier":"buyout"}
```

`tier` 取 `buyout` 或 `subscription`。

- 当前若是沙箱模拟（没有支付宝密钥）：用户确认后调用 `POST /api/pay/sandbox-confirm`，用返回的 `receipt` 作为回执。回执会写明「沙箱模拟回执（非支付宝实单）」，`realFunds` 为 false。
- 当前若是支付宝沙箱或正式环境：把 `cashierUrl` 交给用户。支付结果以 `POST /api/pay/notify` 的验签结果或 `POST /api/pay/query` 为准。浏览器同步跳转 `/pay/return` 不能当作支付成功。

回执：

```http
GET /api/pay/orders/{orderId}/receipt
```

## 不要做的事

- 不要在未付款时复述锁定掉的明细。
- 不要把沙箱模拟回执说成支付宝实单。
- 不要把周期权益里的当次结果保存成用户可永久下载的明文。
