# 银联商务一次性二维码支付设计

## 目标

为授权服务新增银联商务天满 `C扫B支付` 的一次性账单二维码，使月付和年付订单能够通过银联商务聚合二维码完成支付，并由服务端根据经过验签的支付结果自动发放现有授权。

该实现必须在没有真实商户参数时仍可通过确定性的本地测试验证，但不得把模拟测试描述为真实收款已经开通。

## 已确认的官方协议

- 下单接口：`POST /v1/netpay/bills/get-qrcode`。一次性二维码要求 `billNo`、`billDate`、`totalAmount`，二维码成功支付后不能复用。
- 账单号以银联商务分配的 4 位 `msgSrcId` 开头，总长度大于 6 且不超过 31 个字符。
- 请求认证使用 `OPEN-BODY-SIG`：先计算请求体的 SHA-256 小写十六进制摘要，再对 `appId + timestamp + nonce + bodyHash` 使用 `appKey` 做 HMAC-SHA256，最后 Base64 编码。
- 支付结果以 `application/x-www-form-urlencoded` POST 到 `notifyUrl`。除 `sign` 外的已解码原始字段按 ASCII 参数名排序，以 `key=value&...` 拼接通信密钥后做 SHA-256；签名比较必须使用常量时间比较。
- 只有 `billStatus=PAID` 且 `billPayment.status=TRADE_SUCCESS` 才能开通授权。必须同时核对 `mid`、`tid`、`instMid`、账单号和订单原始金额。
- 成功接收回调后返回纯文本 `SUCCESS`；失败返回 `FAILED`。银联商务会在 24 小时内重试未确认通知。
- 回调缺失时使用 `POST /v1/netpay/bills/query` 查询账单状态，不使用其他支付产品的通用订单查询接口。

官方资料：

- <https://open.chinaums.com/saas-doc/openplate/netpay/bills/bills/je24KjzL.html>
- <https://open.chinaums.com/saas-doc/openplate/netpay/bills/bills/dJzA672p.html>
- <https://open.chinaums.com/saas-doc/openplate/netpay/bills/bills/m32QOBX0.html>
- <https://open.chinaums.com/saas-doc/openplate/status/netpay/notice_sign_rules.html>
- <https://res-mop.chinaums.com/upload_doc/%E9%97%A8%E6%88%B7%E6%96%87%E6%A1%A3/%E8%AE%A4%E8%AF%81%E6%B5%81%E7%A8%8B/3d51d70ece917d2973c21ae499b01f4d01135481ceeef20a3462eefba89876ae.pdf>

## 架构

### 支付客户端

新增 `ChinaumsQrProvider`，实现现有 `PaymentProvider`：

1. 根据本地订单 ID、`msgSrcId` 和随机源生成唯一 `billNo`；
2. 以严格 JSON 请求体调用测试或生产环境的固定白名单地址；
3. 生成 `OPEN-BODY-SIG` 请求头；
4. 限制请求时间、重定向和响应体大小；
5. 仅接受 `errCode=SUCCESS`、商户字段完全匹配、`billNo` 原样返回且 `billQRCode` 来自银联商务允许的 HTTPS 主机；
6. 返回 `providerOrderId=billNo` 与 `codeUrl=billQRCode`。

同一客户端提供 `queryBill`，只接受与请求完全匹配的账单结果。查询返回已支付时，将 `notifyId` 缺失场景使用由 `billNo + seqId` 派生的稳定事件 ID，复用现有 webhook 幂等记录。

### 外部账单号映射

`orders` 增加可空、唯一的 `provider_order_id`。内部订单先落库，再调用银联商务下单；得到二维码后立即把 `billNo` 绑定到内部订单。二维码尚未返回给客户端，因此用户不可能在映射完成前扫描付款。

数据库迁移必须幂等，旧订单保持 `NULL`。绑定操作只能执行一次；同一内部订单不能换成另一个账单号，同一账单号不能绑定多个订单。

### 回调处理

新增 `ChinaumsWebhookProcessor`：

- 只接受不超过 64 KiB 的表单正文；
- 拒绝重复字段、过多字段、非法字段名、过长字段和值；
- 对所有收到的字段验签，不静默丢弃未知但合法的银商扩展字段；
- 只支持默认 SHA-256，显式拒绝 MD5；
- 严格解析 `billPayment` JSON；
- 校验商户、终端、业务类型、账单状态、交易状态、金额和支付时间；
- 通过 `provider_order_id` 找到本地订单后，调用现有 `recordWebhookPayment` 原子写入通知事件、订单状态和授权；
- 重复 `notifyId` 返回成功但不重复延长授权；任何内容不一致的重放失败关闭。

HTTP 路由为 `POST /v1/webhooks/chinaums`。仅在当前 provider 为 `chinaums-qr` 时启用。验签或业务校验失败返回 `400` 和纯文本 `FAILED`，成功返回 `200` 和纯文本 `SUCCESS`；响应不得泄露密钥、规范化签名串或内部错误。

### 查询补偿

当客户端轮询一个仍为 pending 的银联商务订单时，服务端至多每 5 秒查询一次该账单。查询结果只有同时满足以下条件才可开通：

- `errCode=SUCCESS`；
- `mid/tid/instMid/billNo/billDate` 与本地绑定一致；
- `billStatus=PAID`；
- `billPayment.status=TRADE_SUCCESS`；
- 外层 `totalAmount` 等于本地订单金额；
- `paySeqId` 和 `payTime` 合法。

网络错误、未知状态或字段不匹配保持 pending，不得猜测成功。回调仍是主路径，查询只是补偿。

## 配置与密钥

新增环境变量：

```text
PAYMENT_PROVIDER=chinaums-qr
CHINAUMS_APP_ID=<平台分配>
CHINAUMS_APP_KEY=<平台分配>
CHINAUMS_MID=<银联商务商户号>
CHINAUMS_TID=<终端号>
CHINAUMS_MSG_SRC_ID=<4位来源编号>
CHINAUMS_NOTIFY_KEY=<支付通知通信密钥>
```

生产环境固定访问 `https://api-mop.chinaums.com`，非生产环境固定访问 `https://test-api-open.chinaums.com`。应用密钥与通知通信密钥作为两个独立值处理，不假设它们相同。所有密钥只从服务器环境读取，不写入日志、数据库、Git 或 XPI。

## 失败与恢复

- 下单超时或返回异常：订单保留 pending，客户端收到通用支付服务错误；不得换账单号自动重试，以免创建重复可支付二维码。
- 数据库绑定失败：不返回二维码，并记录不含密钥的服务端错误供人工对账。
- 回调验签失败或金额不符：返回 `FAILED`，绝不授权。
- 回调重复：返回 `SUCCESS`，授权有效期不再增加。
- 查询暂时失败：保持 pending，下次达到节流窗口后再查。
- 本地订单过期后收到真实成功支付：仍按已有支付存储规则核对金额并授权，避免用户已付款却永远得不到权益；运营侧应依靠账单过期时间尽量避免该场景。

## 明确排除

- 不自动申请银联商务商户、代替用户完成实名认证、短信或人脸验证。
- 不伪造 `mid/tid/appId/appKey/msgSrcId`，没有真实参数时不声称已完成真实支付。
- 本阶段不实现退款、撤销、分账、预授权、自动续费或银行卡代扣。
- 不使用个人云闪付静态收款码推断到账。

## 验收标准

- 官方签名示例可由单元测试复现；任一请求体字节变化都会改变签名。
- 下单请求字段、金额、过期时间、账单号和目标主机均受严格验证。
- 有效回调只开通一次；伪造签名、错误商户、错误金额、错误状态、重复字段和冲突重放均不能开通。
- 查询补偿可以在漏回调时开通一次，未知或失败状态保持 pending。
- sandbox、微信 Native 和微信静态码流程不回归。
- 授权服务测试、构建、根项目测试、类型检查、lint 和生产 XPI 构建均有新鲜成功证据。
