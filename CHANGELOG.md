# Changelog

## 1.0.0

首个公开版本。

- 七个工具：`yingmi_login`、`yingmi_status`、`yingmi_logout`、`yingmi_accounts`、`yingmi_asset_tree`、`yingmi_tools`、`yingmi_call`。
- OAuth 授权码 + PKCE S256，本机回调 `http://127.0.0.1:8765/callback`，动态客户端注册（DCR）。
- 令牌写入 DSH 凭据库；过期前用 `refresh_token` 串行续期（盈米会轮换 refresh_token）。
- MCP 客户端：`initialize` + `Mcp-Session-Id` 复用、JSON/SSE 双解析、401 自动续期重试。
- 输出做 lossless JSON 处理（`undefined` → `null`），宿主不接受非无损 JSON 时报错已规避。
- Windows 下用 `rundll32.exe` 打开授权页，规避 `cmd start` 截断 `&` 导致的 `client_id` 缺失。
