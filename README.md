# dsh-yingmi

给 DeepSeek Harness 加一组工具：用**用户级 OAuth 授权**登录盈米（且慢），然后调用盈米官方 MCP
`https://stargate-partner.yingmi.com/mcp/v2/oauth/qieman` 上的用户账户工具，读取真实账户与持仓。

> 社区插件，非盈米官方项目。

## 为什么不是 apiKey

盈米发给第三方的 apiKey 只能拿到 71 个研究类工具；账户类接口（`/mcp-gw/direct/asset`、
`/v2/internal/user/asset-view/asset-tree` 等）对 apiKey 是空的或 403。只有走浏览器授权拿到的
**用户级令牌**才会暴露 `GetUserAccountsAndProducts`、`GetUserAssetTree` 等账户工具。

## 工具

| 工具 | 作用 |
| --- | --- |
| `yingmi_login` | 发起浏览器 OAuth（授权码 + PKCE S256，本机回调 `http://127.0.0.1:8765/callback`），返回授权页 URL；授权完成后令牌自动存好 |
| `yingmi_status` | 授权状态：是否已授权、用户 ID、令牌剩余分钟数、能否自动续期、是否有进行中的授权 |
| `yingmi_logout` | 撤销令牌并删除本地记录（下次读账户要重新授权） |
| `yingmi_accounts` | 账户结构：总账户、子账户（盈米宝 / 小金库 / 养老 / 攒一笔钱…）、各账户挂的基金产品 |
| `yingmi_asset_tree` | 资产树：总资产金额 + 子账户 → 策略 → 基金三层，含金额、占比、份额；可按账户名过滤 |
| `yingmi_tools` | 列出令牌可用的全部 MCP 工具（90+），支持按关键字过滤 |
| `yingmi_call` | 直调任意 MCP 工具（如 `GetUserProfitCalendar`、`GetUserM4FundDetail`），返回原始 JSON |

## 安装

包内含 `dsh.bundle.patch`，装完即在当前 profile 注册上面七个工具。

从 npm 安装（插件管理器的安装目标填 npm 包名）：

```text
plugin_manager install_bundle  target=dsh-yingmi
```

也可以直接从本目录安装（开发时用，pnpm 会以链接方式指到源码目录，改完源码重载插件即生效）：

```text
plugin_manager install_bundle  target=<本目录绝对路径>
```

装好后刷新页面或新开会话，工具列表里出现 `yingmi_*` 即生效。

## 使用

1. 调 `yingmi_login`（会尝试自动开浏览器；不在电脑前就传 `open_browser: false`，自己把返回的链接打开）。
2. 在浏览器完成手机号 / 密码登录 + 授权（申请 `openid offline_access oapqieman:level1 oapqieman:level2 oapqieman:level3`）。
3. 页面显示「授权成功」后，调 `yingmi_status` 确认。
4. `yingmi_asset_tree` 读总资产与持仓；`yingmi_accounts` 读账户结构；其它接口用 `yingmi_tools` 查名字，再 `yingmi_call` 调。

## 对别人 DSH 的影响（崩溃安全）

插件是 profile 里的**非 required 行**：即使它自身起不来，宿主也只是把这一行标成失败，应用照常启动、其它插件不受影响。在此之上还做了四件事，保证它不会把别人的 DSH 弄坏：

- **启动期零 I/O**：`apply` 只解析 `tools` 服务、注册工具，不读凭据、不写文件、不开端口；凭据/文件只在真正调工具时才碰。
- **凭据键合法**：写进 `ctx.credentials` 的键是 `dsh-yingmi/oauth-token` / `dsh-yingmi/oauth-client`，符合宿主 `<scope>/<id>` 语法（`/^[a-z][a-z0-9-]*$/`）。写非法键（例如 `yingmi.oauth.token`）会让 required 的 credentials 插件解析失败、整个 DSH 打不开——`scripts/smoke.mjs` 会断言这一点。
- **注册失败不影响别人**：单个工具注册抛错只打日志，不会中断 `apply`，也不会标记插件失败。
- **运行期异常不外溢**：OAuth 回调服务常驻 `error` 监听、回调 handler 的 promise 用 `.catch` 接住，都只影响本次授权，不会变成 `uncaughtException` / `unhandledRejection` 打挂宿主进程。

> 反过来提醒：装**旧版本**（用点号凭据键那次构建）的机器已经启动不了 DSH 了，用户侧靠插件自愈不了——插件不执行，就没人改那个 YAML。真要发过这种构建，只能手工把 `~/.dsh/.credentials.yaml` 里的键名改成上面两段式。

## 隐私与令牌

- 插件不采集、不上传任何东西；请求只发往 `https://stargate-partner.yingmi.com`（盈米官方 MCP）。
- 令牌优先写进 DSH 凭据库（`ctx.credentials` 的 GrantRecord，键 `dsh-yingmi/oauth-token` / `dsh-yingmi/oauth-client`）；
  宿主没有 credentials 服务时退化为本机文件 `~/.dsh/yingmi-oauth/store.json`。
- 凭据键必须符合宿主的 `<scope>/<id>` 语法（`/^[a-z][a-z0-9-]*$/`），点号键会让 `credentials-local` 解析失败、整个 DSH 启动崩溃。
- 插件模块必须导出 `inject`（本插件为 `['tools']`），否则 cordis 的 ctx 代理拒绝访问 `ctx.tools`，报 `cannot get property "tools" without inject`。
- 冒烟检查：`node scripts/smoke.mjs`（用假 ctx 验证 7 个工具都能注册且输出可渲染）。
- 访问令牌约 30 分钟过期，插件在调用前用 `refresh_token` 自动续期，刷新失败才要求重新授权。
- 盈米的 `refresh_token` **会轮换**：刷新一次后旧值立即失效，所以令牌只由插件持有，不要让外部脚本拿同一个 refresh_token。
- `yingmi_logout` 会调 `/oauth/revoke` 并清掉本地记录。

## 环境变量

- `YINGMI_CALLBACK_PORT`：本机回调端口，默认 `8765`。改了端口插件会自动重新注册 OAuth 客户端。
- `YINGMI_SCOPES`：覆盖默认申请范围（默认申请三层账户 scope + `offline_access`）。

## 已知边界

- 只做 MCP 层的账户读取；下单 / 申购 / 赎回等交易类接口不在本插件范围。
- 盈米的 `/me`（userinfo）对这类令牌返回 403，用户 ID 从 `id_token` 的 `sub` 取。
- 金额单位是人民币元；`percent` 是小数（`0.3033` 显示为 `30.33%`）。
- Windows 自动开浏览器走 `rundll32.exe url.dll,FileProtocolHandler`。早期用 `cmd start` 时 URL 里的 `&`
  会被 cmd 当命令分隔符，授权页会报 `missing required parameter 'client_id'`。若仍遇到该报错，直接把
  工具返回的完整 URL 手动粘进浏览器即可。

## 开发

- 源码：`lib/index.js`（单文件 Host 插件，无构建步骤、无依赖）。
- `node --check lib/index.js` 做语法检查；`node scripts/smoke.mjs` 做假 ctx 冒烟（工具注册 + 凭据键语法 + 导出形状）；改完在 DSH 里禁用再启用插件即可热重载。
- 版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
