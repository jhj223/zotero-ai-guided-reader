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

- [ ] 明确只选择一种已验收通道：银联商务一次性二维码、微信 Native API，或经营收款码 Windows 到账桥接。
- [ ] 银联商务通道已取得并隔离保存 `AppId`、`AppKey`、15 位商户号、8 位终端号、
      4 位来源编号和独立通知通信密钥；生产回调使用公网 HTTPS。
- [ ] 银联商务通道验证创建一次性账单、原始表单验签、重复通知幂等、五秒查单节流和漏回调恢复；
      个人云闪付码或静态经营码不得代替开放平台商户参数。
- [ ] Native 通道已配置商户号、AppID、证书序列号、商户私钥、APIv3 密钥和平台公钥，
      并使用保留原始正文与签名头的公网 HTTPS 回调。
- [ ] 经营码通道的二维码在 Git 之外，watcher 使用独立 Ed25519 密钥、DPAPI、
      SQLite outbox 和只读 UI Automation；第三方闭源监听 EXE 不得进入发布链路。
- [ ] 经营码通道已在目标 Windows/微信版本上确认官方到账会话、唯一金额解析、健康心跳、
      断网补传、UI 改版失败关闭和 watcher 随系统启动。
- [ ] 生产配置确认 `PAYMENT_PROVIDER` 与验收通道一致；沙盒在生产会启动失败。
- [ ] 真实小额验证：下单、扫码、到账、自动开通、重复事件；月付和年付各完成一次。
- [ ] 验证金额不符、商户号不符、过期回调、错误证书、伪造签名均不能开通。
- [ ] 经营码通道额外验证 nonce、event ID、sequence、消息指纹重放和多候选订单均不开通。
- [ ] 完成真实退款、重复付款、错付和客服查单演练。

## 密钥与服务（阻断）

- [ ] 生产 RSA 私钥只存在于受限服务器/密钥管理系统，插件和 Git 中均不存在。
- [ ] 公钥环、`kid`、issuer、audience 和 HTTPS 服务 URL 固化进正式 XPI。
- [ ] 私钥有加密离线备份，完成恢复演练并限制文件权限。
- [ ] 制定轮换流程：新旧公钥短期并存、发布新版、停止旧私钥签发、到期移除旧公钥。
- [ ] 数据库定期备份；备份恢复后订单唯一约束和授权有效期正确。
- [ ] 反向代理设置 TLS、请求体上限、超时、日志脱敏和服务健康检查。

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
npm run licenses:audit
npm audit --omit=dev --audit-level=high
npm audit --prefix services/licensing --omit=dev --audit-level=high
npm test
npm run license:test
npm run license:build
npm run lint:check
npm run build
npm run release:sbom
npm run release:checksums
```

保存提交 SHA、CI 地址、XPI、`SHA256SUMS.txt` 和人工验收记录。任何一步失败都不得
标记为已发布。
