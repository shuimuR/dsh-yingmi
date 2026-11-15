/**
 * dsh-yingmi —— 盈米基金（且慢）OAuth 授权 + 账户查询 Host 插件
 *
 * 背景：盈米的能力分两套门槛。
 *  - 第三方 apiKey（x-api-key + Bearer）只能看到 71 个研究类工具，账户类接口一律 403/空；
 *  - 用户级 OAuth（授权码 + PKCE，走 stargate-partner.yingmi.com）拿到的 Bearer token，
 *    可以调用 MCP 资源 https://stargate-partner.yingmi.com/mcp/v2/oauth/qieman 上的
 *    用户账户工具（GetUserAccountsAndProducts / GetUserAssetTree / ...）。
 *
 * 所以本插件只做一件事：把「浏览器授权 → 令牌落盘（DSH 凭据库）→ 用令牌调 MCP 工具」
 * 这条链路封成几个工具，避免每次会话都手工跑脚本。
 *
 * 设计要点：
 *  - 令牌优先存 ctx.credentials 的 GrantRecord（加密、随 profile 持久化）；
 *    宿主没有 credentials 服务时退化为 ~/.dsh/yingmi-oauth/store.json。
 *  - 登录用本机回环 http://127.0.0.1:8765/callback 接授权码（native client + PKCE S256），
 *    不依赖任何外部回调域名。授权页在浏览器完成，工具本身立即返回授权 URL。
 *  - MCP 会话（Mcp-Session-Id）缓存在模块内存；401 时自动 refresh（refresh_token 轮换）后重试。
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 常量与端点
// ---------------------------------------------------------------------------

const PLUGIN_VERSION = '1.0.1'
const AUTHORIZATION_SERVER = 'https://stargate-partner.yingmi.com'
const MCP_URL = `${AUTHORIZATION_SERVER}/mcp/v2/oauth/qieman`
const MCP_PROTOCOL_VERSION = '2025-06-18'

/** 默认申请「三层账户权限 + 离线刷新」。三层是盈米资源元数据里声明的全部 scope。 */
const DEFAULT_SCOPES = 'openid offline_access oapqieman:level1 oapqieman:level2 oapqieman:level3'

const CALLBACK_PORT = Number(process.env.YINGMI_CALLBACK_PORT || 8765)
const CALLBACK_HOST = '127.0.0.1'
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback`
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** 凭据库里的键名（GrantRecord payload 即本插件自己的 JSON）。 */
const TOKEN_KEY = 'dsh-yingmi/oauth-token'
const CLIENT_KEY = 'dsh-yingmi/oauth-client'

/** 我们自己关心的账户类 MCP 工具（用于状态提示，不参与权限判断）。 */
const ACCOUNT_TOOL_NAMES = [
  'GetUserAccountsAndProducts',
  'GetUserAssetTree',
  'GetUserM4FundDetail',
  'GetUserAssetCurve',
  'GetUserProfitCalendar',
  'GetUserProfitData',
]

// ---------------------------------------------------------------------------
// 基础工具函数
// ---------------------------------------------------------------------------

class YingmiError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'YingmiError'
    this.code = code
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function sha256(text) {
  return createHash('sha256').update(text).digest()
}

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…（截断，共 ${s.length} 字符）`
}

function fmtMoney(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return value === undefined || value === null ? '—' : String(value)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 盈米的 percent 是小数（0.3033 = 30.33%）。大于 1 的按已是百分数处理。 */
function fmtPercent(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ''
  const percent = n <= 0.999999 && n >= -0.999999 ? n * 100 : n
  return `${percent.toFixed(2)}%`
}

function decodeIdTokenClaims(idToken) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) return undefined
  try {
    const payload = idToken.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function callbackPage(ok, message) {
  const color = ok ? '#0a7f4f' : '#b42318'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>盈米授权</title></head>
<body style="margin:0;padding:56px 32px;font-family:'Segoe UI',system-ui,sans-serif;line-height:1.8;color:#1f2328">
<h2 style="color:${color};margin:0 0 12px">${ok ? '✓ 授权成功' : '✕ 授权失败'}</h2>
<p style="margin:0 0 20px;font-size:15px">${escapeHtml(message)}</p>
<p style="margin:0;color:#6b7280;font-size:13px">可以关闭此页面，回到 DeepSeek Harness 继续。</p>
</body></html>`
}

async function requestJson(url, init, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { ok: response.ok, status: response.status, text, json, headers: response.headers }
}

function formatRpcError(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const message = error.message ?? error.error_description ?? JSON.stringify(error)
  return error.code ? `${message}（${error.code}）` : String(message)
}

function parseJsonRpcBody(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // Streamable HTTP 可能回 text/event-stream：取最后一条 data: 负载。
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('data:'))
      .map((line) => line.trim().slice(5).trim())
    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(dataLines[i])
      } catch {
        /* 继续往前找 */
      }
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 存储：凭据库优先，文件兜底
// ---------------------------------------------------------------------------

function createFileStore(file) {
  async function load() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      return {}
    }
  }
  async function save(all) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
  }
  return {
    backend: 'file',
    location: file,
    async read(key) {
      const all = await load()
      return all[key]
    },
    async write(key, payload) {
      const all = await load()
      all[key] = payload
      await save(all)
    },
    async remove(key) {
      const all = await load()
      delete all[key]
      await save(all)
    },
  }
}

function createStore(ctx) {
  let credentials
  try {
    credentials = ctx.get?.('credentials')
  } catch {
    credentials = undefined
  }
  if (credentials && typeof credentials.readRecord === 'function' && typeof credentials.modifyRecord === 'function') {
    return {
      backend: 'credentials',
      async read(key) {
        try {
          const record = await credentials.readRecord(key)
          if (!record || record.kind !== 'grant') return undefined
          return record.payload
        } catch {
          return undefined
        }
      },
      async write(key, payload) {
        await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload }))
      },
      async remove(key) {
        if (typeof credentials.deleteRecord === 'function') await credentials.deleteRecord(key)
        else await credentials.modifyRecord(key, async () => undefined)
      },
    }
  }
  return createFileStore(path.join(os.homedir(), '.dsh', 'yingmi-oauth', 'store.json'))
}

// ---------------------------------------------------------------------------
// OAuth：客户端注册 / 授权码 + PKCE / 刷新 / 撤销
// ---------------------------------------------------------------------------

function currentScopes() {
  return process.env.YINGMI_SCOPES?.trim() ? process.env.YINGMI_SCOPES.trim() : DEFAULT_SCOPES
}

async function ensureClient(store) {
  const existing = await store.read(CLIENT_KEY)
  if (existing?.client_id && Array.isArray(existing.redirect_uris) && existing.redirect_uris.includes(REDIRECT_URI)) {
    return existing
  }
  const result = await requestJson(`${AUTHORIZATION_SERVER}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'DeepSeek Harness 盈米插件',
      application_type: 'native',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: currentScopes(),
    }),
  })
  if (result.status >= 400 || !result.json?.client_id) {
    throw new YingmiError(`OAuth 客户端注册失败（HTTP ${result.status}）：${truncate(result.text, 300)}`, 'DCR_FAILED')
  }
  const record = {
    client_id: result.json.client_id,
    redirect_uris: Array.isArray(result.json.redirect_uris) ? result.json.redirect_uris : [REDIRECT_URI],
    token_endpoint_auth_method: result.json.token_endpoint_auth_method ?? 'none',
    scope: currentScopes(),
    registered_at: new Date().toISOString(),
  }
  await store.write(CLIENT_KEY, record)
  return record
}

function buildAuthorizeUrl({ clientId, state, codeChallenge, scopes }) {
  const url = new URL('/oauth/authorize', AUTHORIZATION_SERVER)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', scopes)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', MCP_URL)
  return url.toString()
}

async function exchangeCode({ code, clientId, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
    resource: MCP_URL,
  })
  const result = await requestJson(`${AUTHORIZATION_SERVER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  if (result.status >= 400 || !result.json?.access_token) {
    throw new YingmiError(`换取令牌失败（HTTP ${result.status}）：${truncate(result.text, 400)}`, 'TOKEN_EXCHANGE_FAILED')
  }
  return normalizeToken(result.json, clientId)
}

function normalizeToken(json, clientId) {
  const claims = decodeIdTokenClaims(json.id_token)
  const expiresInSeconds = Number(json.expires_in) || 1800
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? 'Bearer',
    scope: json.scope ?? currentScopes(),
    expires_at: Date.now() + expiresInSeconds * 1000,
    expires_in: expiresInSeconds,
    sub: claims?.sub,
    client_id: clientId,
    obtained_at: new Date().toISOString(),
  }
}

async function refreshAccessToken(store, token) {
  const clientId = token.client_id ?? (await ensureClient(store)).client_id
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: clientId,
    resource: MCP_URL,
  })
  const result = await requestJson(`${AUTHORIZATION_SERVER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  if (result.status >= 400 || !result.json?.access_token) {
    throw new YingmiError(`刷新令牌失败（HTTP ${result.status}）：${truncate(result.text, 300)}`, 'RELOGIN_REQUIRED')
  }
  const next = normalizeToken(
    { ...result.json, refresh_token: result.json.refresh_token ?? token.refresh_token },
    clientId,
  )
  next.sub = next.sub ?? token.sub
  return next
}

function isTokenExpired(token, skewMs = 60_000) {
  if (!token?.expires_at) return true
  return Date.now() > token.expires_at - skewMs
}

// 刷新是串行的：refresh_token 会轮换，并发刷新会让彼此失效。
let tokenChain = Promise.resolve()

function ensureToken(store, forceRefresh = false) {
  const run = () => ensureTokenInner(store, forceRefresh)
  const next = tokenChain.then(run, run)
  tokenChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function ensureTokenInner(store, forceRefresh) {
  const token = await store.read(TOKEN_KEY)
  if (!token?.access_token) {
    throw new YingmiError('尚未授权盈米账号，请先调用工具 yingmi_login 完成浏览器授权。', 'LOGIN_REQUIRED')
  }
  if (!forceRefresh && !isTokenExpired(token)) return token
  if (!token.refresh_token) {
    throw new YingmiError('访问令牌已过期且没有 refresh_token，请重新调用 yingmi_login 授权。', 'RELOGIN_REQUIRED')
  }
  let refreshed
  try {
    refreshed = await refreshAccessToken(store, token)
  } catch (error) {
    if (error instanceof YingmiError && error.code === 'RELOGIN_REQUIRED') throw error
    throw new YingmiError(`刷新令牌失败：${error.message}。请重新调用 yingmi_login 授权。`, 'RELOGIN_REQUIRED')
  }
  await store.write(TOKEN_KEY, refreshed)
  return refreshed
}

// ---------------------------------------------------------------------------
// 登录：本机回环回调 + 浏览器授权页
// ---------------------------------------------------------------------------

/** 当前/上次登录尝试；登录页在回调线程里完成后写这里的字段。 */
let pendingLogin

function closeLoginServer() {
  const server = pendingLogin?.server
  if (!server) return
  pendingLogin.server = undefined
  try {
    server.close()
  } catch {
    /* 已关闭 */
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const attempts = [
        // 首选：rundll32 不经过 cmd 的 & 分割，URL 原样交给默认浏览器。
        () => spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
          detached: true,
          stdio: 'ignore',
        }),
        // 兜底：整条命令当 verbatim 字符串交给 cmd，双引号保住 &。
        () => spawn('cmd.exe', ['/c', `start "" "${url.replace(/"/g, '%22')}"`], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
        }),
      ]
      for (const launch of attempts) {
        try {
          const child = launch()
          child.on('error', () => {})
          child.unref()
          return true
        } catch {
          // 换下一种方式
        }
      }
      return false
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
      return true
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

async function startLogin(store) {
  if (
    pendingLogin &&
    pendingLogin.status === 'pending' &&
    Date.now() - pendingLogin.startedAt < LOGIN_TIMEOUT_MS &&
    pendingLogin.server
  ) {
    return {
      authorizeUrl: pendingLogin.authorizeUrl,
      reused: true,
      redirectUri: REDIRECT_URI,
      scopes: pendingLogin.scopes,
    }
  }

  const client = await ensureClient(store)
  const scopes = currentScopes()
  const codeVerifier = base64url(randomBytes(32))
  const codeChallenge = base64url(sha256(codeVerifier))
  const state = randomBytes(16).toString('hex')
  const authorizeUrl = buildAuthorizeUrl({ clientId: client.client_id, state, codeChallenge, scopes })

  const login = {
    status: 'pending',
    startedAt: Date.now(),
    state,
    codeVerifier,
    clientId: client.client_id,
    scopes,
    authorizeUrl,
    server: undefined,
    error: undefined,
  }
  pendingLogin = login

  const server = http.createServer((request, response) => {
    // 必须接住 handleCallback 的 promise：void 丢弃会让异步失败变成
    // unhandledRejection，在某些 Node 配置下直接终止宿主进程。
    handleCallback(request, response, login, store).catch((error) => {
      login.status = 'failed'
      login.error = error?.message ?? String(error)
      try {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(`dsh-yingmi 回调处理失败：${login.error}`)
      } catch {
        /* 连接已断 */
      }
      closeLoginServer()
    })
  })
  // listen 成功后 once('error', onError) 会被摘掉；此时若再出现 'error'
  // 就没有监听器，Node 会抛 uncaughtException 打挂整个宿主。留一个常驻的
  // 日志监听兜住它（真出问题时只影响本次授权，不影响别人的 DSH）。
  server.on('error', (error) => {
    console?.warn?.(`[dsh-yingmi] 回调服务出错：${error?.message ?? error}`)
  })
  login.server = server

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(
        new YingmiError(
          `无法监听 ${CALLBACK_HOST}:${CALLBACK_PORT}（${error.message}）。换一个端口：设置环境变量 YINGMI_CALLBACK_PORT 后重试。`,
          'CALLBACK_PORT_UNAVAILABLE',
        ),
      )
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(CALLBACK_PORT, CALLBACK_HOST)
  })

  const timer = setTimeout(() => {
    if (pendingLogin !== login || login.status !== 'pending') return
    login.status = 'timeout'
    login.error = '授权页 10 分钟未完成，已自动关闭回调监听。'
    closeLoginServer()
  }, LOGIN_TIMEOUT_MS)
  timer.unref?.()

  return { authorizeUrl, reused: false, redirectUri: REDIRECT_URI, scopes: client.scope ?? scopes }
}

async function handleCallback(request, response, login, store) {
  const writePage = (status, html) => {
    try {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    } catch {
      /* 连接已断 */
    }
  }

  let url
  try {
    url = new URL(request.url ?? '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`)
  } catch {
    writePage(400, callbackPage(false, '回调地址无法解析。'))
    return
  }

  if (url.pathname !== '/callback') {
    writePage(404, callbackPage(false, '未知的回调路径。'))
    return
  }

  const error = url.searchParams.get('error')
  if (error) {
    const description = url.searchParams.get('error_description') ?? ''
    login.status = 'failed'
    login.error = `${error}${description ? `：${description}` : ''}`
    writePage(400, callbackPage(false, `授权被拒绝：${login.error}`))
    closeLoginServer()
    return
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) {
    writePage(400, callbackPage(false, '回调缺少 code 参数。'))
    return
  }
  if (login.status !== 'pending') {
    writePage(400, callbackPage(false, '这次授权请求已结束，请重新调用 yingmi_login。'))
    return
  }
  if (state !== login.state) {
    login.status = 'failed'
    login.error = 'state 校验失败：回调参数与发起授权时不一致，已拒绝。'
    writePage(400, callbackPage(false, login.error))
    closeLoginServer()
    return
  }

  try {
    const token = await exchangeCode({ code, clientId: login.clientId, codeVerifier: login.codeVerifier })
    await store.write(TOKEN_KEY, token)
    login.status = 'done'
    login.error = undefined
    mcpSession = { tokenHash: '', sessionId: '', initializedAt: 0 }
    writePage(
      200,
      callbackPage(
        true,
        `已获取盈米授权${token.sub ? `（用户 ${token.sub}）` : ''}。有效期 ${Math.round((token.expires_in ?? 1800) / 60)} 分钟，到期自动用 refresh_token 续期。`,
      ),
    )
  } catch (exchangeError) {
    login.status = 'failed'
    login.error = exchangeError.message
    writePage(500, callbackPage(false, `换取令牌失败：${exchangeError.message}`))
  } finally {
    closeLoginServer()
  }
}

// ---------------------------------------------------------------------------
// MCP 客户端（Streamable HTTP）
// ---------------------------------------------------------------------------

let mcpSession = { tokenHash: '', sessionId: '', initializedAt: 0 }
let rpcId = 0

function tokenHash(token) {
  return createHash('sha256').update(token.access_token).digest('hex').slice(0, 16)
}

async function mcpPost(token, body, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token.access_token}`,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  const text = await response.text()
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id') ?? '',
    text,
    json: parseJsonRpcBody(text),
  }
}

async function ensureSession(token) {
  const hash = tokenHash(token)
  if (mcpSession.tokenHash === hash && (mcpSession.sessionId || mcpSession.initializedAt)) {
    return mcpSession.sessionId
  }
  mcpSession = { tokenHash: hash, sessionId: '', initializedAt: 0 }
  const result = await mcpPost(token, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-yingmi', version: PLUGIN_VERSION },
    },
  })
  if (result.status >= 400 || !result.json || result.json.error) {
    throw new YingmiError(
      `MCP initialize 失败（HTTP ${result.status}）：${result.json?.error ? formatRpcError(result.json.error) : truncate(result.text, 300)}`,
      'MCP_INIT_FAILED',
    )
  }
  mcpSession = { tokenHash: hash, sessionId: result.sessionId, initializedAt: Date.now() }
  return mcpSession.sessionId
}

/** 发一个 MCP JSON-RPC 请求；401 自动刷新令牌重试，会话失效自动重建会话重试。 */
async function mcpRpc(store, method, params) {
  let lastFailure = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = await ensureToken(store, attempt > 0)
    const sessionId = await ensureSession(token)
    const result = await mcpPost(token, { jsonrpc: '2.0', id: ++rpcId, method, params }, sessionId)
    if (result.status === 401) {
      mcpSession = { tokenHash: '', sessionId: '', initializedAt: 0 }
      lastFailure = 'HTTP 401（令牌被拒，已尝试刷新）'
      continue
    }
    if (!result.json) {
      lastFailure = `HTTP ${result.status} 返回无法解析的内容：${truncate(result.text, 200)}`
      // 会话可能已失效：清掉，下一轮重建。
      mcpSession = { tokenHash: '', sessionId: '', initializedAt: 0 }
      continue
    }
    if (result.json.error) {
      throw new YingmiError(`MCP ${method} 调用失败：${formatRpcError(result.json.error)}`, 'MCP_ERROR')
    }
    return result.json.result
  }
  throw new YingmiError(`MCP ${method} 调用失败（重试后仍不成功）：${lastFailure}`, 'MCP_RETRY_EXHAUSTED')
}

function extractToolText(result) {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function toolResultPayload(result) {
  if (result?.isError) {
    const text = extractToolText(result) || JSON.stringify(result)
    throw new YingmiError(`盈米工具返回错误：${truncate(text, 600)}`, 'TOOL_ERROR')
  }
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = extractToolText(result)
  if (!text) return result
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 拆掉盈米统一的 { success, data } 外壳；success === false 直接抛错。 */
function unwrapPayload(payload) {
  if (payload && typeof payload === 'object' && 'success' in payload) {
    if (payload.success === false) {
      const reason = payload.error?.message ?? payload.error?.msg ?? payload.message ?? JSON.stringify(payload.error ?? payload).slice(0, 300)
      throw new YingmiError(`盈米接口返回失败：${reason}`, 'TOOL_FAILED')
    }
    return payload.data ?? payload
  }
  return payload
}

async function callAccountTool(store, name, args) {
  const result = await mcpRpc(store, 'tools/call', { name, arguments: args ?? {} })
  return { payload: unwrapPayload(toolResultPayload(result)), raw: result }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderLoginStatusLines(info) {
  const lines = []
  if (info.authorized) {
    lines.push('盈米账号：已授权')
    lines.push(`  用户 ID：${info.user_id ?? '未知'}`)
    lines.push(`  授权范围：${info.scope ?? '—'}`)
    lines.push(`  访问令牌到期：${info.expires_at_label ?? '—'}（还剩 ${info.minutes_left ?? '?'} 分钟，到期自动续期）`)
    lines.push(`  可刷新：${info.refreshable ? '是' : '否（需要重新授权）'}`)
  } else {
    lines.push('盈米账号：未授权')
    lines.push('  先调用 yingmi_login 完成浏览器授权，再回来查状态。')
  }
  if (info.pending) lines.push(`  进行中的授权：${info.pending}`)
  if (info.store) lines.push(`  令牌存储：${info.store}`)
  if (info.error) lines.push(`  最近一次错误：${info.error}`)
  return lines
}

function renderAccountsLines(value) {
  const data = value?.data ?? {}
  const lines = []
  const root = data.rootAccount
  if (root) lines.push(`总账户：${root.assetName ?? '总账户'}（${root.serviceAccountId ?? '—'}）`)
  const subAccounts = Array.isArray(data.subAccounts) ? data.subAccounts : []
  lines.push(`子账户 ${subAccounts.length} 个：`)
  for (const account of subAccounts) {
    lines.push(`  · ${account.accountName ?? '(未命名)'}${account.accountType ? `（${account.accountType}）` : ''} ${account.serviceAccountId ?? ''}`)
  }
  const products = Array.isArray(data.products) ? data.products : []
  lines.push('')
  lines.push(`持仓产品 ${products.length} 个${value?.truncated_products ? `（只展示前 ${value.shown_products} 个）` : ''}：`)
  for (const product of value?.shown_products_list ?? []) {
    lines.push(`  · ${product.label}${product.parentAccountName ? ` @ ${product.parentAccountName}` : ''}`)
  }
  return lines
}

function productLabel(product) {
  return product.fundName ?? product.prodName ?? product.productName ?? product.prodCode ?? '(未命名)'
}

function renderAssetTreeLines(args, value) {
  const data = value?.data ?? {}
  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  const lines = []
  lines.push(`总资产：¥${fmtMoney(data.totalAsset)}（${accounts.length} 个账户）`)
  if (data.filtered_by) lines.push(`（已按「${data.filtered_by}」过滤只显示匹配账户；总资产仍是全部账户合计。）`)
  if (value?.fetched_at) lines.push(`拉取时间：${new Date(value.fetched_at).toLocaleString('zh-CN')}`)
  for (const account of accounts) {
    lines.push('')
    const percent = typeof account.percent === 'number' ? `（占总资产 ${fmtPercent(account.percent)}）` : ''
    lines.push(`■ ${account.accountName ?? account.nodeId}  ¥${fmtMoney(account.totalAsset)}${percent}`)
    const strategies = Array.isArray(account.strategies) ? account.strategies : []
    for (const strategy of strategies) {
      const details = []
      if (strategy.percent != null) details.push(fmtPercent(strategy.percent))
      if (strategy.paymentMethodName) details.push(`支付方式 ${strategy.paymentMethodName}`)
      lines.push(`  - ${strategy.strategyName ?? strategy.nodeId}  ¥${fmtMoney(strategy.totalAsset)}${details.length ? `  [${details.join(' / ')}]` : ''}`)
      if (args?.include_funds === false) continue
      const funds = Array.isArray(strategy.funds) ? strategy.funds : []
      for (const fund of funds) {
        const share = fund.totalShare != null ? `  份额 ${fmtMoney(fund.totalShare)}` : ''
        const percent = fund.percent != null ? `  占比 ${fmtPercent(fund.percent)}` : ''
        lines.push(`      ${fund.fundCode ?? ''} ${fund.fundName ?? ''}  ¥${fmtMoney(fund.totalAsset)}${percent}${share}`.replace(/\s+/g, ' '))
      }
    }
    if (account.walletAsset?.totalAsset != null) {
      lines.push(`  - ${account.walletAsset.assetName ?? '盈米宝'}  ¥${fmtMoney(account.walletAsset.totalAsset)}`)
    }
  }
  lines.push('')
  lines.push('提示：完整 JSON（含基金层级）用 yingmi_call 直接调用 GetUserAssetTree。')
  return lines
}

function renderToolsLines(value) {
  const tools = value?.tools ?? []
  const lines = [`盈米 MCP 可用工具 ${tools.length} 个${value?.filter ? `（过滤「${value.filter}」后）` : ''}：`]
  for (const tool of tools) {
    lines.push(`  · ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
  }
  if (tools.length === 0) lines.push('  （没有匹配的工具）')
  return lines
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const EMPTY_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function textOutput(render) {
  return { schema: EMPTY_OUTPUT_SCHEMA, render }
}

function asToolArgs(args) {
  return args && typeof args === 'object' ? args : {}
}

/**
 * 宿主要求工具返回值是「无损 JSON」：undefined 字段（未提供/未授权等）会让校验失败，
 * 这里统一做一次 JSON 往返，丢掉 undefined、把 NaN/Infinity 变成 null。
 */
function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function withLosslessOutput(definition) {
  const execute = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      return toLosslessJson(await execute.call(definition, args, exec))
    },
  }
}

function defineTools(store) {
  return [
    {
      name: 'yingmi_login',
      description:
        '发起盈米基金（且慢）账号的浏览器 OAuth 授权。返回一个授权页 URL：把它给用户点击（或让插件自动打开浏览器），完成登录与授权后插件会自己拿到令牌并存好。授权完成前不需要等待；之后调用 yingmi_status 确认，已授权后即可用 yingmi_accounts / yingmi_asset_tree 读取账户与持仓。',
      timeoutMs: 60_000,
      isConcurrencySafe: false,
      parameters: {
        type: 'object',
        properties: {
          open_browser: {
            type: 'boolean',
            description: '是否尝试自动打开系统默认浏览器（默认 true；用户不在电脑前时关掉，只发链接）。',
          },
        },
      },
      output: textOutput((args, value) => {
        const lines = []
        lines.push(value.reused ? '已有一次进行中的盈米授权，直接用它：' : '盈米授权已发起。请在浏览器打开下面的链接并完成登录与授权：')
        lines.push('')
        lines.push(value.authorize_url)
        lines.push('')
        lines.push(`回调地址：${value.redirect_uri}（授权完成后浏览器会跳到本机，页面显示「授权成功」即可关闭）`)
        lines.push(`申请范围：${value.scopes}`)
        if (!value.browser_opened) lines.push('（没有自动打开浏览器：请手动复制链接到浏览器。）')
        lines.push('')
        lines.push('授权完成后再调用 yingmi_status 确认；未完成前该链接在 10 分钟内有效。')
        return [{ type: 'text', text: lines.join('\n') }]
      }),
      async execute(rawArgs) {
        const args = asToolArgs(rawArgs)
        const login = await startLogin(store)
        const browserOpened = args.open_browser === false ? false : openBrowser(login.authorizeUrl)
        return {
          ok: true,
          reused: login.reused,
          authorize_url: login.authorizeUrl,
          redirect_uri: login.redirectUri,
          scopes: login.scopes,
          browser_opened: browserOpened,
        }
      },
    },
    {
      name: 'yingmi_status',
      description:
        '查看盈米 OAuth 授权状态：是否已授权、授权的用户 ID、令牌剩余有效期、能否自动续期，以及是否有一次进行中的授权。不联网查询账户数据。',
      timeoutMs: 30_000,
      isConcurrencySafe: true,
      parameters: { type: 'object', properties: {} },
      output: textOutput((_args, value) => [{ type: 'text', text: renderLoginStatusLines(value).join('\n') }]),
      async execute() {
        let token = await store.read(TOKEN_KEY).catch(() => undefined)
        const pending = pendingLogin
          ? { status: pendingLogin.status, error: pendingLogin.error }
          : undefined
        let error
        if (token && isTokenExpired(token, 0)) {
          try {
            token = await ensureToken(store, true)
          } catch (refreshError) {
            error = refreshError.message
          }
        }
        const authorized = Boolean(token?.access_token)
        return {
          ok: true,
          authorized,
          user_id: token?.sub,
          scope: token?.scope,
          expires_at: token?.expires_at,
          expires_at_label: token?.expires_at ? new Date(token.expires_at).toLocaleString('zh-CN') : undefined,
          minutes_left: token?.expires_at ? Math.max(0, Math.round((token.expires_at - Date.now()) / 60000)) : undefined,
          refreshable: Boolean(token?.refresh_token),
          store: store.backend,
          pending: pending ? `${pending.status}${pending.error ? `：${pending.error}` : ''}` : undefined,
          error,
        }
      },
    },
    {
      name: 'yingmi_logout',
      description: '撤销盈米账号授权：删除本地保存的令牌、回收当前 MCP 会话。之后再查账户需要重新调用 yingmi_login。',
      timeoutMs: 30_000,
      isConcurrencySafe: false,
      parameters: { type: 'object', properties: {} },
      output: textOutput((_args, value) => [{ type: 'text', text: value.message }]),
      async execute() {
        const token = await store.read(TOKEN_KEY).catch(() => undefined)
        let revoked = '无本地令牌，无需撤销'
        if (token?.access_token) {
          try {
            const clientId = token.client_id
            const body = new URLSearchParams({
              token: token.access_token,
              token_type_hint: 'access_token',
              ...(clientId ? { client_id: clientId } : {}),
            })
            const result = await requestJson(`${AUTHORIZATION_SERVER}/oauth/revoke`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
              body: body.toString(),
            })
            revoked = result.ok ? '已在授权服务器撤销' : `撤销接口返回 HTTP ${result.status}（本地令牌仍已删除）`
          } catch (error) {
            revoked = `撤销请求失败（${error.message}）；本地令牌已删除`
          }
        }
        await store.remove(TOKEN_KEY).catch(() => undefined)
        mcpSession = { tokenHash: '', sessionId: '', initializedAt: 0 }
        if (pendingLogin?.status === 'pending') closeLoginServer()
        return { ok: true, message: `盈米授权已清除：${revoked}。` }
      },
    },
    {
      name: 'yingmi_accounts',
      description:
        '读取盈米账号的账户结构与持仓产品清单（MCP 工具 GetUserAccountsAndProducts）：总账户、各子账户（盈米宝账户/小金库/养老账户/攒一笔钱/子女成长基金等）以及每个子账户下挂的基金产品。想知道金额和占比用 yingmi_asset_tree。',
      timeoutMs: 120_000,
      isConcurrencySafe: true,
      parameters: {
        type: 'object',
        properties: {
          max_products: {
            type: 'number',
            description: '最多展示多少个持仓产品，默认 80（避免输出过长；其余仍保留在返回结构里）。',
          },
        },
      },
      output: textOutput((_args, value) => [{ type: 'text', text: renderAccountsLines(value).join('\n') }]),
      async execute(rawArgs) {
        const args = asToolArgs(rawArgs)
        const { payload } = await callAccountTool(store, 'GetUserAccountsAndProducts', {})
        const data = payload ?? {}
        const products = Array.isArray(data.products) ? data.products : []
        const maxProducts = Number.isFinite(Number(args.max_products)) ? Number(args.max_products) : 80
        const shown = products.slice(0, Math.max(1, maxProducts))
        return {
          ok: true,
          data,
          product_count: products.length,
          shown_products: shown.length,
          truncated_products: products.length > shown.length,
          shown_products_list: shown.map((product) => ({
            label: productLabel(product),
            parentAccountName: product.parentAccountName,
            prodCode: product.prodCode,
          })),
        }
      },
    },
    {
      name: 'yingmi_asset_tree',
      description:
        '读取盈米账号的资产树（MCP 工具 GetUserAssetTree）：总资产金额，并按子账户 → 策略 → 基金三层展开持仓（基金代码、名称、金额、占比、份额）。这是"账户信息"的主入口；默认不包含零持仓节点。',
      timeoutMs: 120_000,
      isConcurrencySafe: true,
      parameters: {
        type: 'object',
        properties: {
          include_zero_holding: {
            type: 'boolean',
            description: '是否包含零持仓的账户/策略/基金，默认 false。',
          },
          include_funds: {
            type: 'boolean',
            description: '是否展开到基金层（基金代码/名称/金额/份额），默认 true；只看账户和策略时设为 false。',
          },
          account_name: {
            type: 'string',
            description: '可选：只展示名称包含该关键字的子账户（如「小金库」「养老」）。',
          },
        },
      },
      output: textOutput((args, value) => [{ type: 'text', text: renderAssetTreeLines(args, value).join('\n') }]),
      async execute(rawArgs) {
        const args = asToolArgs(rawArgs)
        const includeZeroHolding = args.include_zero_holding === true
        const { payload } = await callAccountTool(store, 'GetUserAssetTree', { includeZeroHolding })
        let data = payload ?? {}
        if (typeof args.account_name === 'string' && args.account_name.trim() !== '') {
          const keyword = args.account_name.trim()
          const accounts = Array.isArray(data.accounts)
            ? data.accounts.filter((account) => String(account?.accountName ?? '').includes(keyword))
            : []
          data = {
            ...data,
            accounts,
            filtered_by: keyword,
          }
        }
        return { ok: true, data, fetched_at: new Date().toISOString() }
      },
    },
    {
      name: 'yingmi_tools',
      description:
        '列出当前盈米 OAuth 令牌可用的 MCP 工具及一句说明（共 90 多个，含研究类与账户类）。用于发现工具名，找到后用 yingmi_call 直接调用。',
      timeoutMs: 60_000,
      isConcurrencySafe: true,
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: '可选：按工具名或说明中的关键字过滤（如 User、Asset、Fund、Profit）。',
          },
          include_description: {
            type: 'boolean',
            description: '是否附上工具说明（截断到 100 字符），默认 true。',
          },
          max: {
            type: 'number',
            description: '最多列出多少条，默认 200。',
          },
        },
      },
      output: textOutput((_args, value) => [{ type: 'text', text: renderToolsLines(value).join('\n') }]),
      async execute(rawArgs) {
        const args = asToolArgs(rawArgs)
        const result = await mcpRpc(store, 'tools/list', {})
        const rawTools = Array.isArray(result?.tools) ? result.tools : []
        const keyword = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
        const matched = keyword
          ? rawTools.filter(
              (tool) =>
                String(tool.name ?? '').toLowerCase().includes(keyword) ||
                String(tool.description ?? '').toLowerCase().includes(keyword),
            )
          : rawTools
        const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 200
        const tools = matched.slice(0, Math.max(1, max)).map((tool) => ({
          name: tool.name,
          ...(args.include_description === false
            ? {}
            : { description: truncate(String(tool.description ?? '').replace(/\s+/g, ' '), 100) }),
        }))
        return {
          ok: true,
          total: rawTools.length,
          matched: matched.length,
          filter: keyword || undefined,
          tools,
          account_tools: ACCOUNT_TOOL_NAMES.filter((name) => rawTools.some((tool) => tool.name === name)),
        }
      },
    },
    {
      name: 'yingmi_call',
      description:
        '直接调用盈米 MCP 上的任意工具（先用 yingmi_tools 查工具名和参数）。返回工具原始结果（文本块里的 JSON），适合访问插件专用工具没覆盖的接口，如 GetUserProfitCalendar、GetUserAssetCurve、GetUserM4FundDetail、GetPrivateFund*。输出过大时会被截断。',
      timeoutMs: 120_000,
      isConcurrencySafe: true,
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '盈米 MCP 工具名，如 GetUserAssetTree。' },
          arguments: {
            type: 'object',
            description: '传给该工具的参数对象（JSON）。不传则用空对象。',
            additionalProperties: true,
          },
          max_chars: {
            type: 'number',
            description: '返回文本的最大字符数，默认 40000。',
          },
        },
        required: ['tool'],
      },
      output: textOutput((_args, value) => {
        const lines = [`工具 ${value.tool} 调用结果（HTTP ${value.status ?? 'OK'}）：`]
        lines.push('')
        lines.push(value.text)
        if (value.truncated) lines.push('', '（内容已截断；需要完整结果时缩小参数范围或落到文件。）')
        return [{ type: 'text', text: lines.join('\n') }]
      }),
      async execute(rawArgs) {
        const args = asToolArgs(rawArgs)
        if (typeof args.tool !== 'string' || args.tool.trim() === '') {
          throw new YingmiError('参数 tool 必须是非空的盈米 MCP 工具名，例如 GetUserAssetTree。', 'INVALID_ARGS')
        }
        const maxChars = Number.isFinite(Number(args.max_chars)) ? Math.max(1000, Number(args.max_chars)) : 40_000
        const toolArguments =
          args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {}
        const result = await mcpRpc(store, 'tools/call', { name: args.tool.trim(), arguments: toolArguments })
        const text = extractToolText(result) || JSON.stringify(result, null, 1)
        return {
          ok: result?.isError !== true,
          tool: args.tool.trim(),
          status: result?.isError === true ? 'ERROR（工具侧报错，见下方文本）' : 'OK',
          text: truncate(text, maxChars),
          truncated: text.length > maxChars,
          raw_chars: text.length,
        }
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

function resolveService(ctx, name) {
  try {
    const service = ctx.get?.(name)
    if (service) return service
  } catch {
    /* 没有该服务 */
  }
  return ctx[name]
}

export const name = 'dsh-yingmi'
/** 必须声明 inject，否则 cordis 的 ctx 代理会拒绝访问 tools 服务。 */
export const inject = ['tools']

export function apply(ctx) {
  const tools = resolveService(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    console?.warn?.('[dsh-yingmi] 宿主没有 tools 服务，插件未挂载。')
    return
  }

  const store = createStore(ctx)
  const disposers = []

  const register = (definition) => {
    try {
      const disposer = tools.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      console?.error?.(`[dsh-yingmi] 注册工具 ${definition.name} 失败：${error?.message ?? error}`)
    }
  }

  for (const definition of defineTools(store)) register(withLosslessOutput(definition))

  const cleanup = () => {
    if (pendingLogin?.status === 'pending') closeLoginServer()
    while (disposers.length > 0) {
      const disposer = disposers.pop()
      try {
        disposer()
      } catch {
        /* 单个工具注销失败不影响其它 */
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup)
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    })
  }
}

/**
 * 同时提供默认导出：宿主 loader 无论是取模块命名空间还是取 `.default`，
 * 拿到的对象都带 name/inject/apply —— 少了 inject 会在 apply 里碰
 * `ctx.tools` 时被 cordis 拒绝，插件挂不上（本项目踩过）。
 */
export default { name, inject, apply }
