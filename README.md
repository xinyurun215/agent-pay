# 报关合规审查 · Skill Pay

PAYATHON 2026 Skill Pay 的最小闭环：Agent 调用一次审查 Skill，按买断或周期权益交付，再留下一笔可以走到成功状态的支付回执。

规则引擎在本地用关键词、栏位清单和 HS 启发式完成，演示不调用大模型。没有支付宝密钥时走沙箱模拟，回执会写明它不是支付宝实单。

这个分支是合规审查商品，不是办公文具那条收银台路径。

## 本地运行

需要 Node.js 22 或更新版本。没有 npm 依赖。

```bash
npm test
npm start
```

浏览器打开 <http://127.0.0.1:3780>。

另一个终端可以走同一条 API：

```bash
npm run demo
```

`npm start` 会读取仓库根目录的 `.env`（如果存在）。环境变量已经设置时，不会被 `.env` 覆盖。

## 页面上怎么演示沙箱支付

1. 点「填入风险样例」。这一票同时有禁止类关键词、限制类关键词、HS 与品名不符、税码位数不对、净重大于毛重，以及出口合同号、许可证号缺失。
2. 点「由 Agent 调用 Skill」。右侧出现风险等级和三类命中数量。关键词、税号原因和缺失栏位保持锁定。
3. 选择「买断」或「周期」，勾选授权，点「确认沙箱支付」。
4. 页面写出支付回执：`TRADE_SUCCESS`、金额、商户订单号、`SANDBOX-MOCK-` 开头的交易号，以及「沙箱模拟回执（非支付宝实单）」。
5. 付款后服务按档位再交付一次：
   - 买断：完整审查明细，并可下载 Skill 明文。明文里有规则目录，例如未出现在这票货里的「穿山甲」。
   - 周期：只看到这一次的审查结果和剩余次数。点「下载明文存档」会得到 `PLAINTEXT_WITHHELD`。30 天、3 次，不自动续费。
6. 要看另一档，点「换一个买家」，再走一遍。同一买家在权益还有效时不能重复购买。

「填入干净样例」是一票全棉 T 恤，付费后应得到「通过」。

## 两档分别交付什么

| 档位 | 价格 | 付款后拿到什么 | 拿不到什么 |
| --- | --- | --- | --- |
| 买断 | ¥9.90 | 当次及之后调用的完整审查结果，以及 Skill 明文存档 | — |
| 周期 | ¥3.00 | 30 天内最多 3 次调用的当次结果 | Skill 明文、可下载的审查存档、自动续费 |

未付款时 Skill 仍会审查，但响应里只有风险等级和数量。

Agent 侧说明在 [`skills/customs-compliance-review/SKILL.md`](skills/customs-compliance-review/SKILL.md)。

## 环境变量

复制 [`.env.example`](.env.example) 为 `.env`。不要提交 `.env`。

| 变量 | 作用 |
| --- | --- |
| `PAY_MODE` | `sandbox-mock`（默认）、`alipay-sandbox`、`alipay-live` |
| `PORT` | 默认 `3780` |
| `ALIPAY_APP_ID` | 开放平台应用 APPID |
| `ALIPAY_PRIVATE_KEY` | 应用私钥，PKCS#8 或 PKCS#1 PEM |
| `ALIPAY_ALIPAY_PUBLIC_KEY` | 支付宝公钥 |
| `ALIPAY_GATEWAY` | 可选。沙箱默认 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`，正式默认 `https://openapi.alipay.com/gateway.do` |
| `ALIPAY_NOTIFY_URL` | 公网 HTTPS 异步通知地址 |
| `ALIPAY_RETURN_URL` | 可选同步跳转。服务不把它当成支付成功 |
| `DATA_PATH` | 订单与权益文件，默认 `data/store.json`，已 gitignore |

`PAY_MODE` 设成支付宝沙箱或正式，但三个密钥不全时，进程仍停留在沙箱模拟，页面会标明降级来源。

密钥齐全时，下单返回 `alipay.trade.page.pay` 收银台链接。用户付完后点「查询支付结果」，或由支付宝调用 `POST /api/pay/notify`。两条路都会先验签，再核对 `app_id`、`out_trade_no` 和金额，然后才写回执。沙箱模拟确认接口不能把支付宝订单直接标成成功。

支付宝沙箱和正式环境的 `realFunds` 不同：沙箱为 false，正式为 true。沙箱模拟永远是 false。

## 还缺的密钥和报名材料

仓库里没有，也不应提交：

- 支付宝开放平台账号，以及沙箱应用。入口：<https://open.alipay.com/develop/sandbox/app>
- `ALIPAY_APP_ID`、应用私钥、支付宝公钥
- 正式收款前的「电脑网站支付」签约。沙箱里的电脑网站支付可以先联调；沙箱通过不等于可以上线
- 一台能收到 `ALIPAY_NOTIFY_URL` 的公网 HTTPS 地址。本机演示没有这块
- SkillPay 商品上架与安全检测：<https://skillpay.alipay.com/> 。这里只做了可调用的 Skill 和两档交付，商品还没有在 SkillPay 上架
- PAYATHON 报名表和作品提交材料。报名以支付宝 AI 付赛事页当时的要求为准
- 正式商户收款账户。沙箱模拟不产生资金流水

## 测试

```bash
npm test
```

覆盖规则引擎、买断明文、周期拒付明文、沙箱回执、通知验签、查询入账，以及一次 HTTP 闭环。GitHub Actions 在 Node 22 上跑同一条命令。
