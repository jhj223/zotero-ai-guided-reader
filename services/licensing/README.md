# 授权与微信支付服务

该服务是官方付费能力的安全边界。套餐价格、试用、订单、微信支付回调和 RSA 授权
签发均在服务端完成；插件不包含私钥，也不能提交金额改变价格。

## 本地沙盒

```powershell
npm ci --prefix services/licensing
$env:NODE_ENV = "development"
$env:PUBLIC_BASE_URL = "http://127.0.0.1:8787"
$env:SANDBOX_SECRET = "replace-with-at-least-32-random-bytes"
npm run license:dev
```

沙盒二维码打开本地确认页，不会真实扣款。生产环境会拒绝
`PAYMENT_PROVIDER=sandbox`。

## 经营收款码桥接

微信支付官方说明，微信收款商业版订单不能通过 API 查询。因此
`PAYMENT_PROVIDER=wechat-static-qr` 不是微信官方支付 API，而是商户 Windows
电脑到账监听器与本服务之间的签名桥接：

<https://pay.wechatpay.cn/doc/v3/partner/4016183684>

服务端配置示例只使用占位路径：

```powershell
$env:PAYMENT_PROVIDER = "wechat-static-qr"
$env:WECHAT_STATIC_QR_IMAGE_PATH = "D:\secure\wechat\merchant-qr.png"
$env:RECEIPT_WATCHER_KEYS_JSON = `
  '{"merchant-pc-01":"D:\\secure\\wechat\\merchant-pc-01.pub.pem"}'
```

- 二维码必须是 PNG/JPEG 且不超过 700 KiB；文件从受限路径读取，不进入 Git 或 XPI。
- watcher key 必须是 Ed25519 公钥；私钥只保留在商户电脑。
- 监听器必须每 30 秒提交一次签名心跳。120 秒没有健康心跳时，服务拒绝创建新订单。
- 静态码订单使用基础价加 0–99 分的唯一尾数；金额在 48 小时保留窗口内全局不复用。
- 收款事件必须同时通过签名、5 分钟时间窗、nonce、event ID、sequence 和消息指纹检查。
- 无匹配或多个候选订单只记录为 `unmatched`，不会自动开通。

当前 Phase 1 只实现并测试了服务端协议、签名、匹配和授权闭环。Windows 微信监听器、
真实到账文本解析、DPAPI 私钥保护和安装包尚未实现；没有真实监听器健康心跳时无法创建
静态码订单。完成小额月付、年付、断网补传和错误金额验收前，不得描述为已真实上线。

## 生成签名密钥

在受限目录生成，不要把私钥放入项目：

```powershell
npm run license:keys -- E:\secure\zotero-ai-license license-key-2026
```

服务端使用 PEM 私钥和公钥；正式 XPI 构建仅嵌入
`license-public-keys.json` 的内容：

```powershell
$env:LICENSE_SERVER_URL = "https://license.example.com"
$env:LICENSE_ISSUER = "https://license.example.com"
$env:LICENSE_AUDIENCE = "zotero-ai-guided-reader"
$env:LICENSE_PUBLIC_KEYS_JSON = Get-Content `
  E:\secure\zotero-ai-license\license-public-keys.json -Raw
npm run build
```

没有配置这些构建变量的 XPI 会明确显示“未配置官方授权服务”，不会退化为客户端
自报授权。

CI 正式发布也可把同样的公开信息写入
`config/commercial-release.json`（参考 `.example.json`）。该文件只允许包含服务 URL、
issuer、audience 和公钥；绝不能包含服务端私钥或微信密钥。

## 生产配置

复制 `.env.example` 到服务器的密钥管理或进程管理系统，不要提交 `.env`。生产要求：

- 公网 HTTPS `PUBLIC_BASE_URL`；
- 选择微信 Native 时配置商户参数和平台公钥；
- 选择经营收款码桥接时配置受限二维码文件、Ed25519 watcher 公钥和已验收监听器；
- 独立、受限的 RSA 授权私钥；
- 可持久化并备份的 SQLite 数据库；
- 反向代理限制请求体、设置超时并保留微信回调的原始正文；
- 同机反向代理必须覆盖设置 `X-Real-IP`，服务仅在直连地址为 loopback 时信任该头；
- `GET /healthz` 仅返回 `{"status":"ok"}`，用于存活检查。

直接启动：

```powershell
npm ci --prefix services/licensing
npm run license:build
node services/licensing/dist/main.js
```

## 密钥轮换

1. 生成新 `kid` 的密钥；
2. 插件公钥环暂时同时包含新旧公钥并先发布；
3. 服务端切换为新私钥签发；
4. 等待旧离线授权窗口和受支持旧版自然到期；
5. 再从新版本移除旧公钥并销毁旧私钥。

不要在旧客户端还依赖旧公钥时直接删除密钥。完整商业发布门槛见
`docs/COMMERCIAL_RELEASE_CHECKLIST.md`。
