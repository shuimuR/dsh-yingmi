# Changelog

## 1.0.1

发布前的崩溃安全加固（目的是让别人的 DSH 不会因为装了本插件而打不开）。

- 默认导出改为 `{ name, inject, apply }`：宿主 loader 无论取模块命名空间还是 `.default`，都带 `inject`，不会再因 `cannot get property "tools" without inject` 挂不上。
- OAuth 回调服务在 `listen` 成功后保留常驻 `error` 监听，回调 handler 的 promise 用 `.catch` 接住：都不会再把异常冒泡成 `uncaughtException` / `unhandledRejection` 打挂宿主进程。
- `scripts/smoke.mjs` 增加断言：凭据键必须符合宿主 `<scope>/<id>` 语法；默认导出必须带 `name`/`inject`/`apply`。

## 1.0.0

首个公开版本。

- 七个工具：`yingmi_login`、`yingmi_status`、`yingmi_logout`、`yingmi_accounts`、`yingmi_asset_tree`、`yingmi_tools`、`yingmi_call`。
- OAuth 授权码 + PKCE S256，本机回调 `http://127.0.0.1:8765/callback`，动态客户端注册（DCR）。
- 令牌写入 DSH 凭据库；过期前用 `refresh_token` 串行续期（盈米会轮换 refresh_token）。
- MCP 客户端：`initialize` + `Mcp-Session-Id` 复用、JSON/SSE 双解析、401 自动续期重试。
- 输出做 lossless JSON 处理（`undefined` → `null`），宿主不接受非无损 JSON 时报错已规避。
- Windows 下用 `rundll32.exe` 打开授权页，规避 `cmd start` 截断 `&` 导致的 `client_id` 缺失。
