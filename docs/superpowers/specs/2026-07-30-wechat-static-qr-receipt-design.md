# 微信经营收款码自动开通设计

## Status

已确认总体方向，待书面设计复核后实施。

本文补充并局部取代
`2026-07-29-commercial-licensing-design.md` 中“现有静态二维码不接入插件订单”的决定。
原设计里的设备授权、月付/年付套餐、服务端签发、到期策略和 AGPL 边界保持不变。

## Objective

在不申请微信支付 Native API、不依赖常在线手机的前提下，复用现有“微信收款商业版”
经营收款码完成：

1. 插件展示原经营收款码和服务端分配的精确金额。
2. 用户在微信中扫码并手动输入该金额。
3. 商户 Windows 电脑上的微信收到官方到账消息。
4. 本机监听器只通过 Windows UI Automation 读取到账消息。
5. 监听器把签名后的收款事件发送给授权服务。
6. 授权服务按精确金额匹配唯一订单，幂等开通月付或年付权益。
7. 插件轮询到付款后自动保存服务端签名的 entitlement 并立即解锁。

成功不等于使用了微信官方支付 API。微信官方目前不为经营收款码提供订单查询接口，
因此本方案是“可信商户电脑到账监听桥接”，不是官方 Native 支付的替代实现。

## Confirmed Decisions

- 使用用户现有的“223 的店铺”经营收款码，不更换为第三方聚合码。
- 商户端允许一台 Windows 电脑保持微信登录，手机无需常在线。
- 月付和年付都保留，价格仍由授权服务端套餐目录控制。
- 付款匹配使用“基础价 + 唯一分币尾数”，客户端不能指定价格或尾数。
- 插件不能自行上报付款成功；只有商户监听器的有效签名事件才能触发开通。
- 收款码图片不提交到公开 Git 仓库，也不打包进 XPI；部署时从受限文件路径读取。
- 不采用来源不明的现成监听 EXE，不读取微信进程内存或本地数据库。
- 初版只使用 Windows UI Automation，降低封号、供应链和微信版本耦合风险。
- 正式部署只允许一个主监听器密钥；备用监听器必须使用不同 key ID 并单独登记。

## External Constraint

微信支付官方说明：商业版收款订单暂不支持通过 API 查询。因此：

- 不能仅靠云服务器判断该静态码是否到账。
- 不能把支付截图、客户端按钮或用户填写的交易单号当作付款证明。
- 监听器离线时无法实时开通，但恢复后可补传订单有效期内已经发生的到账事件。
- 微信桌面端 UI 变化可能导致解析暂停，必须失败关闭并告警，不能猜测金额后开通。

若将来取得普通商户 Native 或服务商支付能力，应优先切回现有官方 provider，
保留本方案作为受控的兼容通道。

## Approaches Considered

### A. 直接使用 pywinauto 监听指定会话（采用）

监听器只连接微信主窗口和指定的“微信收款助手/商业版”会话，读取新出现的 UIA 文本，
用严格规则识别到账金额。

优点：

- 代码量和依赖面较小，可完整审计。
- 不访问微信数据库、不注入进程、不解密聊天数据。
- 可以先用源码验证真实消息结构，再构建用户自己的签名安装包。

代价：

- 微信 UI 更新后可能要调整控件选择器。
- 初次部署必须用一笔小额真实付款采集并锁定到账消息格式。

### B. 使用 pywechat/pyweixin 高层库（不采用）

这些项目提供微信 4.x UI Automation 封装，但通用消息拉取范围更大，公开 issue 也报告过
全量拉取导致退出登录的情况。其 LGPL 分发边界和额外行为不适合当前最小可信监听器。

可以参考控件定位方式，但生产程序不直接依赖。

### C. 使用第三方闭源收款监听 EXE（禁止）

虽然部分 GitHub 项目宣称支持经营码监听，但只有未签名的 PyInstaller 二进制、没有可审计
源码。支付与授权链路不能引入这种供应链风险。

## Architecture

```text
Zotero 插件
  │  POST /v1/orders（deviceId + planId）
  ▼
授权服务
  │  分配未占用分币尾数，返回经营码图片 + 精确金额
  ▼
用户扫码并输入精确金额
  │
  ▼
Windows 微信官方到账会话
  │  UI Automation（只读）
  ▼
商户收款监听器
  │  Ed25519 签名的 receipt event，经 HTTPS 发送
  ▼
POST /v1/merchant/receipts
  │  验签、重放防护、唯一金额匹配、SQLite 事务
  ▼
服务端 entitlement
  │
  ▼
插件轮询订单并自动解锁
```

监听器和授权服务是商户侧可信组件；Zotero 插件、设备 ID、轮询请求和所有客户端数据都按
不可信处理。

## Project Structure

```text
services/licensing/
  src/payments/staticQr.ts          静态码 provider 与唯一金额分配
  src/payments/receiptEvent.ts      收款事件 canonicalization、验签和校验
  src/database.ts                   金额保留、监听器状态和收款事件表
  src/domain.ts                     唯一订单匹配和幂等权益延长
  src/server.ts                     商户收款、心跳和订单可用性路由
  test/staticQr*.test.ts            provider、签名、重放和匹配测试

tools/wechat-receipt-watcher/
  pyproject.toml                    锁定的 Python 依赖
  src/watcher/config.py             环境与本机配置
  src/watcher/wechat_ui.py          最小 UIA 控件访问
  src/watcher/parser.py             纯文本到账解析
  src/watcher/signing.py            Ed25519 签名与 Windows 密钥保护
  src/watcher/outbox.py             本地 SQLite 幂等队列
  src/watcher/client.py             HTTPS 上报、重试和心跳
  src/watcher/main.py               单实例生命周期
  tests/                            解析、签名和队列测试
```

生产打包在真实消息验证后进行。生成的 EXE/安装包必须由当前仓库源码构建并记录哈希；
不得下载或转发第三方预编译监听器。

## Order Amount Allocation

### Amount Rule

套餐目录提供整数分基础价 `basePriceFen`。静态码订单实际金额为：

```text
payableAmountFen = basePriceFen + suffixFen
suffixFen ∈ [0, 99]
```

服务端为每个新订单选择保留窗口内未使用的最小尾数。插件只显示服务端返回的
`payableAmountFen`，例如“应付 ¥19.93”，并明确提醒用户必须输入完全相同的金额。

### Reservation Rule

- 订单支付有效期：15 分钟。
- 金额尾数保留期：48 小时。
- 48 小时内，所有静态码订单之间的同一实际金额不得再次分配，即使两个套餐的基础价
  相距不足 100 分也不能产生重叠金额。
- 100 个尾数全部占用时，返回 `409 PAYMENT_SLOTS_BUSY`，不得复用或随机碰撞。
- 改价后以 `basePriceFen` 分组，历史订单仍按下单时保存的金额匹配。

较长保留期允许商户电脑离线后补传历史到账消息，并阻止旧消息被重放匹配到新订单。
每个基础价最多提供 100 个候选金额；不同基础价的候选区间重叠时共享容量。该方案适合
当前小规模销售；达到容量前必须迁移官方支付 API，不能通过缩短保留期牺牲正确性。

### Matching Rule

授权服务只在以下条件全部成立时自动开通：

1. 收款事件签名有效，key ID 在允许列表中。
2. 事件 ID 和业务指纹均未处理过。
3. 币种为 CNY，金额是正整数分。
4. 只有一个订单的 `amount_fen` 与事件金额完全相等。
5. 到账显示时间位于该订单创建时间到过期时间之间，允许最多 2 分钟时钟偏差。
6. 订单仍是 `pending`，device、plan 和金额均来自数据库。

零个或多个候选订单时，事件写入 `unmatched_receipts` 并告警，不自动授权。不得按“最接近
金额”、昵称、截图或客户端声明兜底。

## Receipt Event Contract

### Canonical Body

```json
{
  "schema": "wechat-commercial-receipt/v1",
  "keyId": "merchant-pc-01",
  "eventId": "01J...",
  "sequence": 42,
  "observedAt": "2026-07-30T14:35:21.000Z",
  "paidAt": "2026-07-30T14:35:00.000Z",
  "amountFen": 1993,
  "currency": "CNY",
  "source": "wechat-commercial",
  "messageFingerprint": "sha256:..."
}
```

监听器对 UTF-8、无多余空白、键顺序固定的 canonical JSON 签名。请求头：

```text
X-Receipt-Key-Id: merchant-pc-01
X-Receipt-Timestamp: 1785422121
X-Receipt-Nonce: <128-bit random base64url>
X-Receipt-Signature: <Ed25519 signature base64url>
```

签名内容由 HTTP method、固定 path、时间戳、nonce 和 SHA-256 body digest 组成。服务端：

- 使用 key ID 查找预配置公钥。
- 要求请求时间戳与服务端时间相差不超过 5 分钟。
- 对 nonce、event ID 和 message fingerprint 分别做唯一约束。
- 先验签再解析业务字段。
- 使用固定 path，拒绝签名被转用到其他接口。
- 使用 constant-time 的签名库接口，不自制密码算法。

事件本身不包含付款人昵称、头像、完整聊天正文或其他个人信息。原始文本仅允许短期保留在
商户电脑的脱敏调试日志中，默认不记录。

## Watcher Behavior

### UI Scope

- 仅支持 Windows 和微信桌面版。
- 仅连接配置的微信主窗口和配置的官方收款会话名称。
- 只读取当前会话新增的文本控件，不遍历全部联系人或历史聊天。
- 不模拟付款、不发送消息、不点击未知链接。
- 不读取微信进程内存、SQLite、注册表令牌、网络流量或登录凭据。
- 选择器或文本格式不符合预期时进入 `parser_paused`，停止上报付款事件并发送健康告警。

### Parser

到账解析器是纯函数，输入为 UIA 提取的文本数组，输出为零个或一个严格事件：

- 同时要求官方会话名、到账关键词和人民币金额格式。
- 金额只接受最多两位小数，转换为整数分；拒绝千分位歧义、负数和科学计数法。
- 同一 UI 消息中出现多个候选金额时拒绝。
- 测试固定真实样本和相似的非到账消息，防止把退款、活动通知或转账提示当成收款。

首次部署必须通过一笔 ¥0.01 或另行设置的小额真实支付捕获本机微信版本的 UIA 结构。
在样本尚未确认前，生产模式保持关闭，不能凭截图猜测 parser。

### Local Outbox

监听器使用本地 SQLite outbox：

- 识别消息后先在事务中写入 event、fingerprint 和递增 sequence，再尝试网络发送。
- 服务端成功确认后标记 `delivered`，不删除审计记录。
- 网络失败采用有上限的指数退避并持续重试。
- 重启后继续发送未确认事件，不重新生成 event ID。
- 本地只保留最少字段；默认 90 天后清理已确认事件。

### Key Storage

- 第一次安装时在商户电脑生成 Ed25519 密钥对。
- 私钥使用 Windows DPAPI 的 CurrentUser 范围保护，密文文件仅当前 Windows 账户可读。
- 公钥和 key ID通过部署配置登记到授权服务。
- 私钥、恢复材料和监听器签名密钥不得提交 Git、写入日志或发送给插件。
- 密钥轮换时新旧 key ID 可以短暂并存；撤销后旧 key 立即拒绝。

### Heartbeat

监听器每 30 秒发送一次签名心跳，包含版本、微信窗口可见状态、parser 状态和 outbox
积压数量，不包含聊天内容。

授权服务在最近 120 秒没有健康心跳时拒绝创建新的静态码订单并返回
`503 PAYMENT_WATCHER_OFFLINE`。已有订单仍可查询；恢复后监听器继续补传。

## Server API Changes

### `GET /v1/catalog`

在原套餐数据之外增加：

```json
{
  "payment": {
    "provider": "wechat-static-qr",
    "available": true,
    "reason": null
  }
}
```

不可用时只返回稳定错误码，不暴露监听器主机名、微信账号或内部状态。

### `POST /v1/orders`

当 provider 为 `wechat-static-qr`：

1. 检查监听器心跳。
2. 在 `BEGIN IMMEDIATE` 事务中分配尾数并创建订单。
3. 从受限路径读取、校验并缓存经营码图片。
4. 返回 `amountFen`、`baseAmountFen`、`qrDataUrl`、`expiresAt` 和 poll token。

如果图片缺失、过大、不是允许的 PNG/JPEG，服务启动失败。图片最大 700 KiB，只在启动时
读取，不接受客户端路径。

### `POST /v1/merchant/receipts`

仅供商户监听器调用。限制：

- HTTPS only，反向代理后仍需正确识别受信代理。
- 原始 body 上限 16 KiB。
- Ed25519 请求签名和 5 分钟时间戳窗口。
- key ID 和来源级速率限制。
- 验签失败返回通用 401，不说明 key、nonce 或签名哪一项错误。
- 有效重复事件返回幂等成功；签名有效但无法匹配返回已接收且进入人工核对。

### `POST /v1/merchant/heartbeat`

使用相同签名协议和独立 path。服务端只保存最后健康时间、版本和状态码。

## Data Model Changes

```text
orders
  provider TEXT
  base_amount_fen INTEGER
  amount_fen INTEGER
  amount_reserved_until INTEGER

receipt_events
  event_id TEXT PRIMARY KEY
  key_id TEXT
  sequence INTEGER
  message_fingerprint TEXT UNIQUE
  amount_fen INTEGER
  paid_at INTEGER
  observed_at INTEGER
  received_at INTEGER
  matched_order_id TEXT NULL
  status TEXT                 matched | unmatched | duplicate

receipt_nonces
  key_id TEXT
  nonce_hash TEXT
  expires_at INTEGER
  PRIMARY KEY (key_id, nonce_hash)

watcher_status
  key_id TEXT PRIMARY KEY
  watcher_version TEXT
  state TEXT
  outbox_pending INTEGER
  last_seen_at INTEGER
```

金额分配、订单写入、收款事件写入、订单 `pending -> paid` 和 entitlement 顺延均使用
SQLite 事务。所有 SQL 参数化；不把外部字段拼接进 SQL。

## Plugin UI

- 套餐按钮仍显示“Pro 月付”和“Pro 年付”。
- 下单后显示经营收款码、醒目的精确金额、订单剩余时间和以下提示：
  “请扫码后手动输入 ¥19.93，金额必须完全一致；不要按基础价付款。”
- 二维码按原比例缩放，窄侧栏不横向溢出。
- 保留自动轮询；付款后立即显示权益到期日并解锁。
- 监听器离线时不展示可付款二维码，显示“自动到账服务暂不可用，请稍后再试”。
- 订单过期后停止付款提示并要求重新下单，不让用户继续向旧金额付款。
- 不要求用户填写微信昵称、备注、订单号或上传截图。

## Security Boundaries

### Always

- 服务端决定套餐价格、实际付款金额、订单候选和权益期限。
- 监听器请求必须签名、带时间窗口并通过三层重放保护。
- 收款事件只能匹配唯一的精确金额和有效订单时间窗。
- 商户监听器私钥与 entitlement 签发私钥分离，泄露一个不能伪造另一个。
- 监听器和服务端日志默认脱敏，不记录付款人身份或完整微信正文。
- 生产通信使用 HTTPS 并校验证书；禁止 `verify=False`。
- 依赖使用 lockfile/hash 锁定并进行许可证与供应链审查。

### Never

- 信任插件、用户截图、“我已支付”按钮或客户端金额。
- 使用第三方闭源监听 EXE。
- 将经营收款码、监听器私钥、服务端私钥或部署数据库提交到 Git/XPI。
- 关闭签名、TLS、时间窗或重放检查来“临时解决”到账问题。
- 在解析不确定、多个订单冲突或监听器不健康时自动开通。
- 声称此方案是微信官方 API 或不可破解 DRM。

### Residual Risks

- 商户 Windows 账户或电脑被完全控制时，攻击者可以使用本机监听器密钥伪造收款事件。
  通过专用低权限账户、磁盘加密、系统更新和快速撤销 key ID 降低风险。
- 微信 UI 改版可能使监听器停止。默认失败关闭，影响是延迟开通而不是错误开通。
- 经营码允许手输金额，用户输错时不会自动匹配，需要退款或人工核对。
- 唯一分币方案容量有限，不适合高并发销售。
- AGPL 允许他人修改客户端；真正的权益可信边界是服务端签名和官方服务，不是本地防破解。

## Testing Strategy

### Red-Green Unit Tests

- 为基础价分配未使用尾数，保证所有静态码订单的实际金额在 48 小时内全局不重复。
- 100 个尾数耗尽时明确失败。
- 客户端传入金额不能改变订单金额。
- 合法 Ed25519 事件通过；篡改 body、path、timestamp 或 nonce 均失败。
- event ID、nonce 和 fingerprint 任一重复都不重复延长权益。
- 零候选、多候选、过期窗口和金额不符进入 unmatched。
- 月付与年付按原有 30/365 天规则顺延。
- parser 只接受确认过的真实到账样本，拒绝退款、活动、转账和多金额消息。
- outbox 重启后重发同一 event ID，确认后不重复发送。
- DPAPI 密钥只能在 Windows 当前用户上下文解密。

### Integration Tests

- 临时 SQLite 完成“创建静态码订单—签名收款事件—自动 entitlement”闭环。
- 监听器离线时不能新建订单，恢复心跳后可以。
- 网络中断后 outbox 补发，服务端只开通一次。
- 原有 `sandbox` 和 `wechat-native` provider 回归测试保持通过。
- 插件窄侧栏正确显示长宽比二维码、精确金额和离线提示。

### Real Payment Acceptance

只有以下步骤全部完成，才能称为真实自动收款可用：

1. 在目标 Windows 电脑和当前微信版本上采集一笔小额真实到账 UIA 样本。
2. 确认 parser 对该消息得到唯一正确金额。
3. 使用月付测试订单付款，插件在一次权益延长后自动解锁。
4. 重启监听器并验证 outbox 不重复开通。
5. 断网付款、恢复网络后补传并正确匹配。
6. 错误金额保持 unmatched，不开通其他订单。
7. 年付订单完成同样验证。
8. 核对商户微信账单金额与授权服务审计记录。

真实测试使用的金额、时间、订单号和截图不得提交公开仓库。

## Operational Requirements

- 监听器随 Windows 登录自动启动，单实例运行。
- 微信退出、会话找不到、parser 暂停、心跳中断和 outbox 连续失败需要本机醒目告警。
- 授权服务提供不含隐私的运营健康检查。
- 每日备份授权 SQLite；备份加密并验证可恢复。
- 保留人工处理 unmatched 收款的最小运营流程，但人工开通必须有独立审计记录。
- 发布前构建 SBOM、第三方许可证清单、源码归档和产物 SHA-256。

## Implementation Phases

### Phase 1 — 协议与服务端

- 静态码 provider、金额保留、监听器签名协议、心跳和收款匹配。
- 使用合成签名事件完成自动授权测试。

### Phase 2 — Windows 监听器

- 最小 pywinauto UIA 访问、严格 parser、DPAPI 密钥和 SQLite outbox。
- 使用合成 UIA 数据完成自动化测试。

### Phase 3 — 真实微信验收

- 用户保持目标电脑微信登录。
- 采集小额真实到账样本，修正并锁定选择器与 parser。
- 完成月付、年付、断网补传和重放测试。

### Phase 4 — 生产封装

- 从源码构建监听器 EXE/安装包、开机启动、哈希、签名和运维文档。
- 部署二维码受限文件和监听器公钥。

每个阶段独立提交并验证。Phase 3 需要真实付款，未完成前不得把 Phase 1/2 的模拟闭环描述成
已经真实上线。

## Success Criteria

- 用户看到的是现有经营收款码和服务端分配的唯一精确金额。
- 月付和年付均可由真实到账消息自动开通，不需要手机常在线或用户上传凭证。
- 插件、HTTP 客户端或重复消息无法伪造或重复延长权益。
- 监听器离线、解析异常、金额冲突和支付超时全部失败关闭，不错误授权。
- 商户二维码和所有私钥不进入公开仓库或 XPI。
- 原 sandbox、官方 wechat-native、试用、授权过期和原文导航行为不回归。
- 根项目、授权服务和监听器的测试、lint、类型检查和构建均有新鲜成功证据。

## Research References

- 微信支付官方：《微信收款商业版的订单能否通过 API 进行查询？》
  <https://pay.wechatpay.cn/doc/v3/partner/4016183684>
- pywinauto：Windows GUI Automation，BSD-3-Clause。
  <https://github.com/pywinauto/pywinauto>
- pywechat：微信 UI Automation 参考实现，LGPL-2.1。
  <https://github.com/Hello-Mr-Crab/pywechat>
- pywechat issue #267：全量消息拉取导致退出登录的风险报告。
  <https://github.com/Hello-Mr-Crab/pywechat/issues/267>
- pywechat issue #162：最小 pywinauto 监听方法参考。
  <https://github.com/Hello-Mr-Crab/pywechat/issues/162>
- mpay_v2：唯一分币匹配和到账文本解析的开源参考，不能直接复用其较弱签名协议。
  <https://github.com/techhaha/mpay_v2>
