# 爱发电自动授权 Worker

这是 Zotero AI 带读的生产授权服务，运行在 Cloudflare Workers + D1。用户在插件中
创建订单后打开爱发电付款页；Webhook 只触发查单，服务必须再次调用爱发电查单接口
核对订单、套餐、金额和成功状态后开通 Pro。定时任务每 10 分钟补查近期订单，避免通知
丢失导致用户已经付款但未开通。

## 安全边界

- 插件不能提交价格，也不包含授权私钥或爱发电 API Token。
- 回调本身不能开通权益；即便平台当前提供 Webhook 签名，本服务仍只读取交易号和关联
  订单号作为最小查单提示。必须通过带创作者 ID 和 Token 签名的爱发电查单 API 重新
  核对后才能开通，避免把通知格式或单次通知当作最终支付事实。
- 月付固定为 590 分/30 天，年付固定为 4900 分/365 天。
- D1 唯一约束和原子批处理保证同一订单、交易或回调不会重复延长权益；过期未付款订单
  保留 30 天后分批清理，过期限流记录也按固定批量清理，不删除付费审计记录。
- 所有敏感值使用 Cloudflare Secret；`.dev.vars`、`.wrangler` 和本地密钥均被 Git 忽略。
- 生产出站付款请求只允许代码中固定的爱发电 HTTPS 地址。

## 本地验证

在仓库根目录运行：

```powershell
npm install --prefix services/licensing-worker
npm run license:worker:migrate:local
npm run license:worker:test
npm run license:worker:typecheck
npm run license:worker:dry-run
```

测试使用专用临时 D1 和测试密钥，不需要真实爱发电账号。

## 首次部署

1. 登录并创建 D1：

   ```powershell
   npx --prefix services/licensing-worker wrangler login
   npx --prefix services/licensing-worker wrangler d1 create zotero-ai-guided-reader-licensing
   ```

2. 将命令返回的 `database_id` 写入 `wrangler.jsonc` 的 D1 绑定，然后执行：

   ```powershell
   npx --prefix services/licensing-worker wrangler d1 migrations apply DB --remote
   ```

3. 通过 `wrangler secret put 名称` 的隐藏输入设置以下 10 个绑定。不要把值写入命令行、
   文档、Git、聊天记录或 XPI：
   - `LICENSE_ISSUER`：部署后的 Worker HTTPS 根地址；
   - `LICENSE_AUDIENCE`：固定为插件受众标识；
   - `LICENSE_KEY_ID`：当前授权签名公钥的标识；
   - `LICENSE_PRIVATE_KEY_PEM`：PKCS#8 RSA 私钥；
   - `SOURCE_URL`：与部署版本对应的公开源码地址；
   - `RATE_LIMIT_PEPPER`：至少 32 字节的随机值；
   - `AFDIAN_USER_ID`：爱发电开发者页显示的 32 位用户 ID；
   - `AFDIAN_API_TOKEN`：已轮换的爱发电 API Token；
   - `AFDIAN_MONTHLY_PLAN_ID`：5.90 元月付方案 ID；
   - `AFDIAN_YEARLY_PLAN_ID`：49.00 元年付方案 ID。

   其中私钥、Pepper 和 API Token 是严格秘密；账号及套餐 ID 也按秘密保存，减少不必要
   暴露。设置后只用 `wrangler secret list` 检查名称，不读取或打印值。

4. 部署并检查：

   ```powershell
   npm run license:worker:deploy
   Invoke-RestMethod https://<worker-domain>/healthz
   Invoke-RestMethod https://<worker-domain>/v1/catalog
   ```

5. 在爱发电开发者页面把 Webhook URL 设为：

   ```text
   https://<worker-domain>/v1/webhooks/afdian
   ```

   测试通知必须返回 `{"ec":200,"em":""}`，但测试或伪造订单不得产生权益。

## 正式 XPI

正式插件只嵌入 Worker URL、issuer、audience、key ID 和 RSA 公钥 JWK。推荐把这些公开
信息写入被 Git 忽略的 `config/commercial-release.json`，结构参考
`config/commercial-release.example.json`。然后运行：

```powershell
npm run commercial:check
npm run build
```

构建后应扫描 XPI，确认不存在 `AFDIAN_API_TOKEN`、`LICENSE_PRIVATE_KEY_PEM`、
`RATE_LIMIT_PEPPER`、`.dev.vars` 或真实付款载荷。

## 备份、恢复与轮换

- D1 默认提供 Time Travel。发布前记录数据库 ID，并定期执行恢复演练；迁移前先确认
  可恢复时间点。恢复后检查订单/交易唯一约束和权益有效期。
- 回滚 Worker 代码时不要回滚已经应用的 D1 迁移；先部署向后兼容版本，再处理迁移。
- 授权密钥轮换顺序：生成新 key ID → 新旧公钥同时进入插件 → 先发布插件 → Worker
  切换新私钥 → 等旧离线窗口结束 → 后续版本移除旧公钥。
- 爱发电 Token 泄露时立即在爱发电重新生成，再更新 Cloudflare Secret；旧 Token 不得
  继续使用。
- Webhook 漏发由每 10 分钟一次的 cron 补查。持续失败时查看脱敏 Worker 日志，修复后
  手动触发或等待下一轮；不得绕过查单直接写入权益。

## 上线验收

真实收费前必须完成：月付 5.90 元付款并自动开通 30 天、重复通知不重复延长、伪造通知
和错误金额不开通、漏通知后 cron 恢复开通、退款/错付客服流程。年付协议由自动测试覆盖，
对外开放前仍需完成一次经明确授权的 49 元真实验收。
