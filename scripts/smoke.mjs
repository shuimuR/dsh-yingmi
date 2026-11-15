// 冒烟检查：给插件一个假 ctx，确认 7 个工具都注册成功、execute 能跑通输出渲染。
import assert from 'node:assert/strict'

const mod = await import('file:///C:/Users/Slieart/Documents/deepseek-harness/default-workspace/plugins/dsh-yingmi/lib/index.js')
assert.equal(mod.name, 'dsh-yingmi')
assert.deepEqual(mod.inject, ['tools'])

const registered = []
const store = { get: () => undefined, set: () => {}, clear: () => {}, remove: () => {} }
const ctx = {
  get: (name) => (name === 'tools' ? { register: (d) => { registered.push(d); return () => {} } } : undefined),
  logger: console,
  on: () => () => {},
}
mod.apply(ctx)

assert.equal(registered.length, 7, `注册数量应为 7，实际 ${registered.length}`)
const names = registered.map((d) => d.name)
assert.deepEqual(names, [
  'yingmi_login', 'yingmi_status', 'yingmi_logout', 'yingmi_accounts',
  'yingmi_asset_tree', 'yingmi_tools', 'yingmi_call',
])
for (const d of registered) {
  assert.equal(typeof d.execute, 'function', `${d.name} 缺 execute`)
  assert.equal(d.parameters.type, 'object', `${d.name} 参数不是 JSON Schema object`)
  assert.equal(typeof d.output.render, 'function', `${d.name} 缺 output.render`)
}
// 未登录时 yingmi_status 应能渲染（不抛错），输出必须是可 JSON 往返的值
const status = registered.find((d) => d.name === 'yingmi_status')
const value = await status.execute({}, {})
assert.equal(typeof value, 'object')
const text = status.output.render({}, value).map((c) => c.text).join('\n')
assert.ok(text.length > 0)
// 宿主 loader 可能取模块命名空间，也可能取 .default；两种路径都必须带 inject，
// 否则 cordis 会拒绝 ctx.tools，插件静默挂不上。
assert.equal(mod.default.name, 'dsh-yingmi', 'default 导出缺 name')
assert.deepEqual(mod.default.inject, ['tools'], 'default 导出缺 inject')
assert.equal(typeof mod.default.apply, 'function', 'default 导出缺 apply')

// 凭据键必须符合宿主 <scope>/<id> 语法（两段都匹配 /^[a-z][a-z0-9-]*$/）。
// 键名不合法会让 credentials 插件（required=true）启动失败 —— 别人的 DSH 会直接打不开。
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const keys = [...source.matchAll(/const (?:TOKEN_KEY|CLIENT_KEY) = '([^']+)'/g)].map((m) => m[1])
assert.equal(keys.length, 2, '没找到 TOKEN_KEY / CLIENT_KEY 字面量')
for (const key of keys) {
  const segments = key.split('/')
  assert.equal(segments.length, 2, `凭据键 ${key} 必须是两段 <scope>/<id>`)
  for (const segment of segments) {
    assert.match(segment, /^[a-z][a-z0-9-]*$/, `凭据键 ${key} 有一段不合法，会让宿主凭据库加载失败`)
  }
}

console.log('OK: 7/7 工具注册，输出可渲染')
console.log('status 未登录渲染:', text.split('\n')[0])
