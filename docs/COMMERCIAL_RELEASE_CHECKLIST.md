# 商业发布验收清单

只有所有“阻断项”完成后，才可以把沙盒版本描述为可正式收费。

## 经营与法律（阻断）

- [ ] 填写经营主体法定名称、地址、客服/安全/隐私/侵权邮箱。
- [ ] 由经营主体复核并发布 TERMS_OF_SERVICE.md 和 PRIVACY.md。
- [ ] 明确月付、年付价格、退款、重复扣款、发票和未成年人流程。
- [ ] 根据实际服务器、日志、监控和客服供应商补齐数据保存与委托处理说明。
- [ ] 确认网站、服务器、域名、备案和经营资质要求。
- [ ] 做品牌在先检索；如需专用权，向国家知识产权局申请相应类别商标。
- [ ] 如需登记证明，按国家版权局规则准备软件著作权登记材料。

软件著作权和商标申请都不能由代码提交自动完成；取得官方受理或证书前不得声称
“已注册”“已认证”或使用 `®`。

## 支付通道（阻断）

- [ ] 爱发电创作者账号可正常收款；5.90 元月付和 49 元年付方案均已发布且方案 ID 与
      Cloudflare Secret 一致。
- [ ] 爱发电 API Token 已在截图泄露后重新生成；旧 Token 已失效，新 Token 只存在于
      Cloudflare Secret 和受限备份，不进入 Git、日志、聊天或 XPI。
- [ ] Webhook 固定为生产 Worker 的 `/v1/webhooks/afdian`，测试通知返回
      `{"ec":200,"em":""}`，但测试数据不会创建授权。
- [ ] 验证 Webhook 只触发查单，每次开通都必须通过带创作者凭据签名的爱发电查单 API；
      回调内容单独到达不能开通。
- [ ] 真实验证：月付 5.90 元下单、付款、自动开通 30 天并在 Zotero 中刷新成功。
- [ ] 年付 49 元在正式开放前完成一次经明确授权的真实付款和 365 天开通验证。
- [ ] 验证金额不符、套餐不符、过期付款、伪造通知和查询失败均不能开通。
- [ ] 验证重复 Webhook、重复轮询、cron 补查和并发通知不会重复延长权益。
- [ ] 暂停 Webhook 后付款，确认 10 分钟 cron 能通过查单恢复开通。
- [ ] 完成真实退款、重复付款、错付和客服查单演练。

## 密钥与服务（阻断）

- [ ] 生产 RSA 私钥只存在于 Cloudflare Secret 和受限备份，插件和 Git 中均不存在。
- [ ] 公钥环、`kid`、issuer、audience 和 HTTPS 服务 URL 固化进正式 XPI。
- [ ] 私钥有加密离线备份，完成恢复演练并限制文件权限。
- [ ] 制定轮换流程：新旧公钥短期并存、发布新版、停止旧私钥签发、到期移除旧公钥。
- [ ] D1 Time Travel/备份与恢复已演练；恢复后订单唯一约束和授权有效期正确。
- [ ] Worker 请求体上限、出站超时、日志脱敏、速率限制、`/healthz` 和 cron 告警已检查。

## GitHub 与 Zotero 市场（阻断）

- [ ] 创建公开 GitHub 仓库并配置真实 `repository`、`bugs`、`homepage` 和更新地址。
- [ ] 将插件 ID 从 `@local` 改为长期稳定且不会冲突的正式 ID。
- [ ] 发布 AGPL 对应源码、LICENSE、NOTICE、第三方声明、隐私和支持页面。
- [ ] 正式 XPI 来自干净提交；GitHub Release 同时提供 `SHA256SUMS.txt`。
- [ ] 在 Zotero Add-on Market 提交名称、说明、图标、兼容版本、仓库和更新清单。
- [ ] 从全新 Zotero 配置安装市场版，验证试用、月付、年付、到期、缓存阅读和卸载。

## 每次发布

```powershell
npm ci
npm ci --prefix services/licensing
npm ci --prefix services/licensing-worker
npm ci --prefix services/afdian-webhook-relay
npm run licenses:audit
npm audit --omit=dev --audit-level=high
npm audit --prefix services/licensing --omit=dev --audit-level=high
npm audit --prefix services/licensing-worker --omit=dev --audit-level=high
npm audit --prefix services/afdian-webhook-relay --omit=dev --audit-level=high
npm test
npm run legacy-license:test
npm run legacy-license:build
npm run license:worker:test
npm run license:worker:typecheck
npm run license:worker:dry-run
npm run afdian:relay:test
npm run lint:check
npm run build
npm run release:sbom
npm run release:checksums
```

保存提交 SHA、CI 地址、XPI、`SHA256SUMS.txt` 和人工验收记录。任何一步失败都不得
标记为已发布。
