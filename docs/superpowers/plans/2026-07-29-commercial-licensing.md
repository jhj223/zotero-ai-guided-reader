# AI 带读商业授权实施计划

**Goal:** 为 Zotero AI 带读增加 7 天试用、月付/年付套餐、动态二维码支付和服务端签名授权，并保留现有 BYOK 与缓存阅读体验。

**Architecture:** 新增独立 Node 24 + SQLite 授权服务，支付能力通过 provider interface 隔离；插件只信任服务端签名 entitlement。先用 sandbox provider 验证完整购买闭环，再接微信 Native APIv3。授权只限制新生成、重新生成和导出，不影响缓存阅读及原文跳转。

**Tech Stack:** TypeScript、React 19、Zotero 9、Firefox 115 WebCrypto、Node 24、`node:sqlite`、Node test runner。

---

## Task 1: 固定协议与纯授权逻辑

**Files:**

- Create: `src/core/license.ts`
- Create: `test/license.test.ts`
- Modify: `docs/superpowers/specs/2026-07-29-commercial-licensing-design.md`

- [x] 先写试用、月付、年付、过期和离线窗口的失败测试。
- [x] 实现套餐类型、entitlement claims 和纯状态计算。
- [x] 验证：`npx tsx --test test/license.test.ts`

## Task 2: 建立授权服务领域与 SQLite 存储

**Files:**

- Create: `services/licensing/package.json`
- Create: `services/licensing/tsconfig.json`
- Create: `services/licensing/src/domain.ts`
- Create: `services/licensing/src/database.ts`
- Create: `services/licensing/test/domain.test.ts`

- [x] 先写试用不可重置、服务端定价和续费顺延的失败测试。
- [x] 建立 schema、事务和领域服务。
- [x] 验证：`npm run license:test -- --test-name-pattern="domain"`

## Task 3: 签发和验证 entitlement

**Files:**

- Create: `services/licensing/src/entitlements.ts`
- Create: `services/licensing/test/entitlements.test.ts`
- Create: `src/core/licenseToken.ts`
- Create: `test/licenseToken.test.ts`

- [x] 先写有效、篡改、错误设备、过期和错误签名测试。
- [x] 服务端使用 RSA-SHA256 签发，插件使用 WebCrypto 验签。
- [x] 确认 Firefox 115 兼容算法，不使用 Ed25519。
- [x] 验证：`npm run license:test -- --test-name-pattern="entitlement"` 和 `npx tsx --test test/licenseToken.test.ts`

## Task 4: 支付 provider 与幂等订单

**Files:**

- Create: `services/licensing/src/payments/provider.ts`
- Create: `services/licensing/src/payments/sandbox.ts`
- Create: `services/licensing/src/payments/wechatNative.ts`
- Create: `services/licensing/test/payments.test.ts`
- Modify: `services/licensing/src/database.ts`

- [x] 先写 sandbox 闭环、重复回调和金额不匹配测试。
- [x] 实现 provider 接口、sandbox 下单/回调和订单事务。
- [x] 实现微信 APIv3 Native 下单、回调验签、解密与字段核对；查单留在真实商户上线门禁。
- [x] 验证：`npm run license:test -- --test-name-pattern="payment"`

## Task 5: HTTP API

**Files:**

- Create: `services/licensing/src/config.ts`
- Create: `services/licensing/src/server.ts`
- Create: `services/licensing/test/server.test.ts`
- Modify: `package.json`

- [x] 先写 catalog、trial、order、poll、refresh 和 webhook 路由测试。
- [x] 实现严格 JSON 限制、CORS、超时、错误映射和健康检查。
- [x] 返回二维码 PNG data URL，不返回可执行 HTML。
- [x] 验证：`npm run license:test`

## Task 6: Zotero 授权存储和客户端

**Files:**

- Create: `src/runtime/licenseStorage.ts`
- Create: `src/runtime/licenseClient.ts`
- Create: `test/licenseClient.test.ts`
- Modify: `addon/prefs.js`

- [x] 先写随机设备 ID、令牌保存、HTTPS 限制、创建订单和轮询测试。
- [x] 实现存储和可取消 HTTP 客户端。
- [x] 验证：`npx tsx --test test/licenseClient.test.ts`

## Task 7: 侧栏授权 UI 和功能门控

**Files:**

- Create: `src/ui/LicensePanel.tsx`
- Modify: `src/ui/GuidedReaderApp.tsx`
- Modify: `src/runtime/guidedReadingService.ts`
- Create: `test/licenseUi.test.ts`
- Modify: `test/guidedReaderUi.test.ts`

- [x] 先写试用/Pro/过期、双套餐、二维码和按钮门控测试。
- [x] 接入授权初始化、轮询、刷新和窄侧栏样式。
- [x] 缓存阅读与原文导航保持可用。
- [x] 验证：`npx tsx --test test/licenseUi.test.ts test/guidedReaderUi.test.ts`

## Task 8: 构建配置、部署和市场文档

**Files:**

- Modify: `zotero-plugin.config.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Create: `services/licensing/README.md`

- [x] 增加构建时服务地址和公钥注入，缺失时明确禁用收费而非指向假地址。
- [x] 记录 Node 24、持久卷、密钥生成、微信凭据和回调 URL。
- [x] 记录 GitHub Release 与 `zotero-addons-scraper` 收录步骤。
- [x] 验证：`npm run lint:check`

## Task 9: 全量验证、实机检查和提交

- [x] 运行 `npm test`。
- [x] 运行 `npm run license:test`。
- [x] 运行 `npm run lint:check`。
- [x] 运行 `npm run build`。
- [x] 运行 `npm run license:build`。
- [x] 对构建产物和暂存区做密钥扫描。
- [x] 在 Zotero 中临时安装插件并通过初始化 smoke test；在本地服务完成试用、月付订单、sandbox 支付和刷新闭环。
- [ ] 进行一次聚焦的复杂任务审查，修正阻塞问题后重复验证。
- [x] 使用 Conventional Commits 创建本地提交。

## Production Gate

以下条件满足前不得声称真实微信支付上线：

- [ ] 取得普通商户或服务商 Native 支付凭据。
- [ ] 部署 HTTPS 授权服务并配置持久数据库和备份。
- [ ] 真实小额完成月付、年付、重复回调和订单查询验证。
- [ ] 完成退款并确认权益和账务处理符合产品规则。
- [ ] 发布正式 GitHub Release XPI 并向 Add-on Market 数据源提交条目。
