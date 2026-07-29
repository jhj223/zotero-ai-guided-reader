# Zotero Add-on Market 上架材料

目标仓库：`jhj223/zotero-ai-guided-reader`
正式插件 ID：`zotero-ai-guided-reader@jhj223`
建议标签：`ai`、`reader`

当前 Zotero Add-on Market 的主要数据源是
[`syt2/zotero-addons-scraper`](https://github.com/syt2/zotero-addons-scraper)。
其贡献说明要求在 `addons/` 中新增名为 `{owner}@{repo}` 的条目，并可用 JSON 指定
最多两个标签。

在正式 GitHub 仓库和首个 Release 可公开访问后，向该数据源提交：

文件名：

```text
addons/jhj223@zotero-ai-guided-reader
```

文件内容：

```json
{ "tags": ["ai", "reader"] }
```

## 提交前自动检查

- 仓库为公开状态，README、AGPL 源码、隐私、条款、安全和第三方声明可访问；
- GitHub Release 有 XPI、`update.json` 和 `SHA256SUMS.txt`；
- XPI 的 `manifest.json` 使用稳定正式 ID，兼容目标 Zotero 版本；
- Release 下载链接无需登录且返回真实 XPI，不是 HTML 错误页；
- 从全新 Zotero 配置能安装、启动、卸载并再次安装；
- 插件内价格、套餐、7 天试用、主动扫码续费和 BYOK 说明与公开条款一致；
- 不把尚未部署的微信自动开通、商标、软著或隐私联系人写成已完成。

插件市场仓库本身只负责发现和安装，不负责代收款。付款二维码由官方授权服务按订单
动态生成，不能把个人静态经营收款码直接写进市场元数据或 XPI。
