# AI 带读商业授权设计

## Objective

在保持 Zotero Add-on Market 免费发现、安装和更新的前提下，为 AI 带读增加可验证的商业授权：

- 新设备获得 7 天完整试用。
- 提供月付 Pro（30 天）和年付 Pro（365 天）两个套餐。
- 用户主动扫码支付；支付成功后当前设备自动开通或续费。
- 不实现自动扣款，不托管 MinerU、LLM 或语义定位密钥。
- 缓存导读和原文定位始终可读；试用或 Pro 到期后，仅限制新的生成、重新生成、Note 保存和 Anki 导出。

成功意味着：沙盒支付可以完整演示“创建订单—展示二维码—支付回调—自动授权”，真实微信支付代码严格按 APIv3 规则实现；未配置可开发的微信 Native/服务商凭据时，产品不得伪装成已经可以真实收款。

## Confirmed Product Decisions

- 插件市场只承担发现、XPI 安装和版本更新，订单与授权由独立服务管理。
- 月付和年付同时提供，价格由服务端套餐目录返回，改价不需要重新发布 XPI。
- 月付为 30 天、年付为 365 天；均为单次主动扫码支付，不自动续扣。
- 现有“微信收款商业版”静态二维码继续用于原有经营收款，不接入插件订单。
- 插件继续 BYOK，会员费不包含 MinerU 或模型调用额度。
- 初版按一个随机设备 ID 自动授权，不采集硬件指纹，不建立邮箱、手机号或机构账号系统。
- 本地缓存内容不因授权过期而删除或隐藏。

## Tech Stack

- Zotero 客户端：TypeScript 5.9、React 19、Zotero 9 bootstrap API、Firefox 115 WebCrypto。
- 授权服务：Node.js 24、TypeScript、Node 内置 HTTP、`node:sqlite`、Node Crypto。
- 二维码：服务端生成 PNG data URL，插件只把它作为图片显示。
- 授权令牌：RSASSA-PKCS1-v1_5 + SHA-256 签名的紧凑令牌；私钥只在服务端，插件仅内置公钥。
- 支付：provider interface；`sandbox` 用于自动化测试，`wechat-native` 实现普通商户 Native 支付。服务商模式需要另写 provider，不能复用普通商户参数冒充。

`node:sqlite` 依赖 Node 24 运行时。生产容器固定 Node 24，并把数据库放在持久卷；不支持无持久存储的临时运行环境。

## Commands

根项目：

```powershell
npm test
npm run lint:check
npm run build
```

授权服务：

```powershell
npm run license:test
npm run license:build
npm run license:dev
```

完整验证：

```powershell
npm run test
npm run license:test
npm run lint:check
npm run build
npm run license:build
```

## Project Structure

```text
src/core/license.ts                 纯授权状态与套餐逻辑
src/runtime/licenseClient.ts        Zotero 到授权服务的 HTTP 客户端
src/runtime/licenseStorage.ts       设备 ID 与已签名令牌的 Zotero 偏好存储
src/ui/LicensePanel.tsx             试用、套餐、二维码和支付轮询 UI
test/license*.test.ts               插件端授权单元测试

services/licensing/
  package.json                      独立服务脚本与依赖
  tsconfig.json                     服务端 TypeScript 配置
  src/config.ts                     环境变量解析
  src/domain.ts                     套餐、订单、授权领域逻辑
  src/database.ts                   SQLite schema 和事务
  src/entitlements.ts               令牌签发与验证
  src/payments/provider.ts          支付 provider 协议
  src/payments/sandbox.ts           可重复的测试 provider
  src/payments/wechatNative.ts      微信 APIv3 下单、请求签名和响应验签
  src/payments/wechatWebhook.ts     微信回调验签、解密和业务字段校验
  src/server.ts                     HTTP 路由、校验和错误响应
  test/*.test.ts                    服务端领域与 HTTP 集成测试
```

## Code Style

领域逻辑使用显式类型和依赖注入，网络、时钟、随机数和数据库不得隐藏在纯函数内部：

```ts
export interface Plan {
  id: "pro_monthly" | "pro_yearly";
  durationDays: 30 | 365;
  priceFen: number;
}

export function extendEntitlement(
  currentExpiry: number | undefined,
  durationDays: number,
  paidAt: number,
): number {
  const startsAt = Math.max(currentExpiry || 0, paidAt);
  return startsAt + durationDays * 24 * 60 * 60 * 1000;
}
```

- 两空格缩进、双引号、80 列目标，遵循根项目 Prettier/ESLint。
- 公共 API 返回稳定的机器码和简短中文消息；不得返回堆栈、密钥或数据库细节。
- 所有金额使用整数分，所有时间在协议中使用 ISO 8601 UTC 字符串。

## API Contract

### `GET /v1/catalog`

返回可售套餐和试用天数：

```json
{
  "trialDays": 7,
  "plans": [
    {
      "id": "pro_monthly",
      "label": "Pro 月付",
      "durationDays": 30,
      "priceFen": 1990
    },
    {
      "id": "pro_yearly",
      "label": "Pro 年付",
      "durationDays": 365,
      "priceFen": 19900
    }
  ]
}
```

示例价格只是默认部署值，服务端环境变量可以覆盖。

### `POST /v1/trials`

输入随机 `deviceId` 和插件版本。一个设备只创建一次试用；重复请求返回同一试用状态，
不延长试用。设备已经存在 Pro 时返回 `409 ENTITLEMENT_EXISTS`，绝不通过试用接口
重新签发付费授权。

### `POST /v1/orders`

输入 `deviceId`、`planId` 和插件版本。返回不可猜测的 `orderId`、单独的 `pollToken`、过期时间以及二维码 PNG data URL。服务端固定套餐金额，拒绝客户端传入价格。

### `GET /v1/orders/{orderId}`

使用 `Authorization: Bearer <pollToken>` 查询。付款后返回 `paid` 和当前设备的已签名 entitlement。未知、过期或不匹配的 token 返回通用 404/401。

### `POST /v1/entitlements/refresh`

输入当前设备 ID 和已签名 entitlement。服务端验证后返回最新 token。Token 的离线有效窗口最长 30 天且绝不超过已付权益到期时间。
已经彻底超过 `validUntil` 的旧 token 不能用于恢复后来购买的权益。

### `POST /v1/webhooks/wechat`

仅接受微信支付 APIv3 回调。处理顺序：

1. 使用原始请求体和 `Wechatpay-*` 头验签。
2. 校验时间戳窗口并防止通知重放。
3. 使用 APIv3 密钥解密 AES-256-GCM resource。
4. 同时核对商户号、商户订单号、微信交易号、币种和整数金额。
5. 在单个 SQLite 事务中完成 `pending -> paid`、交易号去重和权益延长。
6. 重复合法通知返回成功但不得二次延长权益。
7. 不确定时保持订单未支付，依赖微信重试或运营侧查单处理；绝不因为客户端声称成功而开通。自动查单补偿尚未实现，不得在上线说明中声称已有。

### `GET /healthz` 与 `GET /v1/about`

`/healthz` 只返回最小存活状态；`/v1/about` 返回 AGPL 许可证和对应源码 URL。
生产配置缺少真实 HTTPS `SOURCE_URL` 时启动失败。

## Data Model

```text
devices
  id TEXT PRIMARY KEY
  created_at INTEGER
  trial_started_at INTEGER NULL
  trial_expires_at INTEGER NULL

orders
  id TEXT PRIMARY KEY
  device_id TEXT
  plan_id TEXT
  amount_fen INTEGER
  status TEXT               pending | paid | expired | closed
  poll_token_hash TEXT
  transaction_id TEXT UNIQUE NULL
  created_at INTEGER
  expires_at INTEGER
  paid_at INTEGER NULL

entitlements
  device_id TEXT PRIMARY KEY
  plan_id TEXT
  valid_until INTEGER
  updated_at INTEGER

webhook_events
  event_id TEXT PRIMARY KEY
  received_at INTEGER
```

数据库启用 foreign keys、WAL 和 busy timeout。所有外部输入使用 prepared statement；不得拼接 SQL。

## Client Behavior

- 首次打开侧栏时生成随机 UUID 并请求试用；网络失败时显示“授权服务暂不可用”，不伪造试用。
- 本地令牌必须先验签，再检查 `deviceId`、`issuedAt`、`offlineUntil` 和 `validUntil`。
- 试用、Pro 和过期状态显示在侧栏顶部，窄侧栏允许正常换行。
- 月付和年付按钮从目录生成；创建订单后显示二维码、金额、订单有效期和“我已支付，刷新状态”。
- 订单页面每 3 秒轮询一次，最多持续 5 分钟；面板关闭或组件卸载后停止轮询。
- 支付成功后自动保存新令牌并立即解锁。
- 授权过期时仍可读取缓存和跳转原文，但生成、重新生成、Note 保存和 Anki 导出按钮被禁用，并给出开通入口。
- 任何服务端、二维码或错误文本都按纯数据呈现；不得执行服务端 HTML。

## Testing Strategy

### 插件端单元测试

- 月付、年付、试用、过期和离线窗口的状态计算。
- 篡改 payload、签名不匹配、设备不匹配和过期令牌均被拒绝。
- 客户端只接受 HTTPS 生产地址；测试可显式允许 loopback HTTP。
- 创建订单与轮询的超时、取消和错误映射。
- UI 包含状态、双套餐、二维码和受限操作接线。

### 服务端单元与集成测试

- 试用只创建一次。
- 试用接口不能重新签发既有 Pro，来源和设备限流相互独立。
- 套餐价格完全来自服务端。
- 当前权益未到期时，续费从原到期时间顺延。
- 同一支付通知重复投递不会重复延长。
- 金额、商户号或订单号不匹配不会开通。
- 无效签名、过期时间戳、错误 AES-GCM tag 和重放通知均被拒绝。
- HTTP 路由不泄露 token、密钥、SQL 或堆栈。
- 临时 SQLite 数据库完成完整 sandbox 购买闭环。

所有生产代码遵循测试先行：先运行单个新测试并确认因缺少行为而失败，再写最小实现使其通过。

## Boundaries

### Always

- 服务端掌握价格、支付状态和权益到期时间。
- 金额使用整数分，订单 ID、poll token 和设备 ID 不可预测。
- 微信回调使用原始 body 验签并保证幂等。
- 私钥、APIv3 密钥、商户证书和支付凭据只从服务端环境变量读取。
- 私钥和证书从环境变量指定的受限文件读取；密钥本体不得进入环境日志、Git 或 XPI。
- 本地提交前运行完整测试、类型检查、lint、插件 XPI 和授权服务构建。

### Ask First

- 开通自动扣款、机构席位、账号登录、设备迁移或托管 AI 调用额度。
- 更换 AGPL、引入闭源依赖或公开发布 GitHub 仓库。
- 使用会产生费用的生产服务器、域名或第三方支付服务商。

### Never

- 提交真实支付凭据、私钥、API key、数据库或 Zotero 用户数据。
- 用现有微信收款商业版静态码冒充自动支付。
- 信任客户端上报的付款成功、金额、有效期或套餐。
- 在未取得 Native/服务商凭据并完成真实小额支付与退款验证前声称真实微信收款已经上线。
- 删除用户的缓存导读或因授权失败阻止原文导航。

## Marketplace and AGPL Boundary

- Add-on Market 条目来自公开 GitHub Release 中的 XPI；市场不处理收费。
- 仓库当前 AGPL-3.0-or-later 保持不变。XPI 的相应源码继续公开，用户依法可以修改和再分发。
- 收费对象是官方构建、持续更新、支持和服务器签发的商业权益；本地授权检查只能作为正常用户体验和滥用抑制，不能被描述为不可破解 DRM。
- 新插件应提交到 `syt2/zotero-addons-scraper`；旧 `zotero-chinese/zotero-plugins` 不再接收新条目。
- AGPL 网络服务通过 `/v1/about` 公布对应源码位置；发布包附 NOTICE、第三方声明、
  隐私、条款、商标、侵权投诉和安全政策。

## Success Criteria

- 沙盒模式下，从 Zotero 侧栏创建月付或年付订单后，测试支付可自动取得有效 Pro entitlement。
- 两种套餐分别延长 30 天和 365 天；未到期续费从当前到期日顺延。
- 重复回调、错误金额、错误商户号、篡改 token 和设备不匹配不能延长权益。
- 试用只能创建一次并在 7 天后失效。
- 授权过期不影响缓存阅读和原文跳转，只限制明确的 Pro 操作。
- 根项目和授权服务测试、lint、类型检查与构建均成功。
- XPI 安装后窄侧栏中授权面板无文字重叠，二维码和双套餐按钮可用。
- 真实微信上线状态单独记录：只有拿到 Native/服务商凭据、部署 HTTPS 服务并完成真实小额支付、回调、续费和退款验证后才算完成。

## Open External Dependencies

- 当前微信收款商业版静态码没有订单查询 API，不能作为自动支付 provider。
- 真实上线仍需要以下二选一：
  - 普通商户 Native：商户号、已绑定 APPID、APIv3 密钥、商户私钥及微信支付公钥；
  - 服务商 Native：服务商提供的下单/回调能力和当前店铺的子商户号。
- 需要一个具有 HTTPS、持久磁盘和安全环境变量的公开服务地址。
- 公开上架需要把仓库从本地占位元数据迁移到真实 GitHub 仓库并发布正式 XPI。
