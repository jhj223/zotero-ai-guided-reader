# 第三方软件声明

本项目本身采用 `AGPL-3.0-or-later`。以下清单按
插件、Cloudflare 授权 Worker、爱发电 Webhook 中继和旧版授权服务各自的
`package-lock.json` 中实际进入运行时的依赖生成；开发、测试和构建专用依赖不在此表。发布前由
`npm run licenses:audit` 自动阻止未知或未审核的运行时许可证进入发行包。

## 插件运行时

| 软件包                  |   版本 | 许可证                                           |
| ----------------------- | -----: | ------------------------------------------------ |
| core-util-is            |  1.0.3 | MIT                                              |
| immediate               |  3.0.6 | MIT                                              |
| inherits                |  2.0.4 | ISC                                              |
| isarray                 |  1.0.0 | MIT                                              |
| jszip                   | 3.10.1 | MIT OR GPL-3.0-or-later（本项目按 MIT 条款使用） |
| katex                   | 0.18.4 | MIT                                              |
| commander（KaTeX 依赖） |  8.3.0 | MIT                                              |
| lie                     |  3.3.0 | MIT                                              |
| pako                    | 1.0.11 | MIT AND Zlib                                     |
| process-nextick-args    |  2.0.1 | MIT                                              |
| react                   | 19.2.7 | MIT                                              |
| react-dom               | 19.2.7 | MIT                                              |
| readable-stream         |  2.3.8 | MIT                                              |
| safe-buffer             |  5.1.2 | MIT                                              |
| scheduler               | 0.27.0 | MIT                                              |
| setimmediate            |  1.0.5 | MIT                                              |
| string_decoder          |  1.1.1 | MIT                                              |
| util-deprecate          |  1.0.2 | MIT                                              |
| zotero-plugin-toolkit   |  5.1.4 | MIT                                              |

## Cloudflare 授权 Worker 运行时

| 软件包 | 版本   | 许可证 |
| ------ | ------ | ------ |
| hono   | 4.13.1 | MIT    |

## 爱发电 Webhook 中继运行时

中继没有第三方运行时依赖。

## 旧版授权服务运行时（未部署）

此目录只保留兼容性测试和历史迁移参考，不是当前生产收费链路。

| 软件包                  |   版本 | 许可证 |
| ----------------------- | -----: | ------ |
| ansi-regex              |  5.0.1 | MIT    |
| ansi-styles             |  4.3.0 | MIT    |
| camelcase               |  5.3.1 | MIT    |
| cliui                   |  6.0.0 | ISC    |
| color-convert           |  2.0.1 | MIT    |
| color-name              |  1.1.4 | MIT    |
| decamelize              |  1.2.0 | MIT    |
| dijkstrajs              |  1.0.3 | MIT    |
| emoji-regex             |  8.0.0 | MIT    |
| find-up                 |  4.1.0 | MIT    |
| get-caller-file         |  2.0.5 | ISC    |
| is-fullwidth-code-point |  3.0.0 | MIT    |
| locate-path             |  5.0.0 | MIT    |
| p-limit                 |  2.3.0 | MIT    |
| p-locate                |  4.1.0 | MIT    |
| p-try                   |  2.2.0 | MIT    |
| path-exists             |  4.0.0 | MIT    |
| pngjs                   |  5.0.0 | MIT    |
| qrcode                  |  1.5.4 | MIT    |
| require-directory       |  2.1.1 | MIT    |
| require-main-filename   |  2.0.0 | ISC    |
| set-blocking            |  2.0.0 | ISC    |
| string-width            |  4.2.3 | MIT    |
| strip-ansi              |  6.0.1 | MIT    |
| which-module            |  2.0.1 | ISC    |
| wrap-ansi               |  6.2.0 | MIT    |
| y18n                    |  4.0.3 | ISC    |
| yargs                   | 15.4.1 | MIT    |
| yargs-parser            | 18.1.3 | ISC    |

各软件包的完整许可证文本随安装包源码或其上游发行物提供。版本升级后必须重新运行
许可证审计并更新本文件；不能把本清单当作对未来版本的预先批准。
