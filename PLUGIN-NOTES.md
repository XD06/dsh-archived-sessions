# DSH 插件实战笔记

本文记录**实际踩过**的问题与验证过有效的做法，来自 `@local/dsh-archived-sessions` 这个插件的完整开发过程。
凡是标注"已验证"的结论都经过真实运行确认；标注"未验证"的是推断，不要直接当结论用。

适用版本：DeepSeek Harness `0.2.1-rc.2`（Windows / Electron 桌面版，Web UI）。

---

## 1. 插件最小结构

```
my-plugin/
├── package.json        # 声明 bundle + client 入口
├── cordis.patch.yml    # 把自己 insert 进 profile 的插件树
├── host.js             # Host 半边（Node 侧）
├── client.js           # Client 半边（浏览器侧）
├── locale/{zh,en}.json # 设置页的标题/描述（可选）
└── icon.svg            # 插件列表图标（可选）
```

### package.json 关键字段

```json
{
  "name": "@local/dsh-my-plugin",
  "type": "module",
  "exports": {
    ".": "./host.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["host.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-workspace"
      ]
    }
  }
}
```

- `exports["."]` 是 **Host 入口**，`exports["./client"]` 是 **浏览器入口**，两者不能写反。
- `dsh.client.inject` 列出你**依赖其 slot / 运行时**的其它 Client 包，没列全会拿不到对应能力。

### ⚠️ 版本声明：用 `engines.dsh`，不要用 `peerDependencies`

**踩过的坑**：DSH 升级到 `0.2.1-rc.3` 后，插件直接起不来：

```
@local/dsh-archived-sessions@1.0.0 与 DSH 0.2.1-rc.3 不兼容
（要求 @deepseek-ai/dsh-typert-protocol 0.2.1-rc.2）
请卸载后重新安装与当前 DSH 兼容的版本。
```

**根因**（读 `dsh-app-boot/lib/index.js` 的 `unmetRequirements` 得到）：

```js
function satisfies(runtimeVersion, range) {
  return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}
```

关键点：`peerDependencies` 里的版本范围**不是**跟那个包的版本比，而是跟 **DSH 运行时版本**比。
所以 `"@deepseek-ai/dsh-typert-protocol": "0.2.1-rc.2"` 实际含义是"要求 DSH 运行时恰好是 0.2.1-rc.2"，
DSH 一升级就必然失败。语义完全用错了。

**正确写法**：

```json
"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }
```

DSH 的判定顺序是：`engines.dsh` **存在就独占判定**，此时 `peerDependencies` 被完全忽略。
用 `engines.dsh` 表达"我适配哪个 DSH 版本"，语义才对。

**不要写 `^0.2.1-rc.2`**。`includePrerelease: true` 下 `^` 对预发布版的行为容易误判，
用显式的 `>=A <B` 上下界最可控。

**验证方法**（不要靠"装上去试试"）：把 `unmetRequirements` / `evaluatePluginCompatibility`
从 `app.asar` 里抠出来，用真实 `semver` 跑一遍：

```js
evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.3')  // undefined = 通过
```

**注意 `engines` 的位置**：它必须写在**插件自己的** package.json 里，
不是 profile 的 package.json。

**生效方式**：`loadProfileDirectory` 每次启动都重新读 manifest 现算，**没有缓存**。
所以改完 manifest **重启 DSH 即可**，不需要卸载重装。

### ⚠️ 改完版本声明后的连带故障：包被 pnpm 卸掉了

把 `peerDependencies` 换成 `engines.dsh` 之后，**pnpm 会把那个包从 profile 里移除**
——因为 `peerDependencies` 是 pnpm 的安装依据，`engines` 不是。

于是 Host 半边启动时报：

```
启用失败：dsh: warning: 1 entry did not activate archived-sessions
(@local/dsh-archived-sessions): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package
'@deepseek-ai/dsh-typert-protocol' imported from ...\archived-sessions\host.js
```

**教训**：`peerDependencies` 一旦写过，就不只是"版本声明"，它同时是**安装契约**。
移除它等于让运行时 import 悬空。

**根治法：能不用 DSH 内部包就别用。**

这个插件走的是 `connection.fetch.register` 的 HTTP 路由，**根本不经过 Typert 网关**，
却为了一个 `RemoteError` 而依赖 `@deepseek-ai/dsh-typert-protocol`——纯属历史包袱。
而那个包导出的 `Remote` 和 `TypertRemoteService` 在本插件里**从未被使用**
（`ArchivedSessionsController` 定义了但没有任何地方 `ctx.plugin()` 它）。

现在改成本地实现：

```js
export class PurgeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PurgeError'
    this.code = code
    this.details = details
  }
}
```

Client 端只读 `body.code` 这个字符串，形状对齐即可，**不需要真的 instanceof 那个类**。

结果：`host.js` 现在**零外部依赖**，任意目录、任意 profile 都能加载：

```bash
node -e "import('./host.js').then(m => console.log(Object.keys(m).length, 'exports OK'))"
```

**通用原则**：插件里每一个 `import '@deepseek-ai/...'` 都是一个会随 DSH 升级而断的耦合点。
先问自己"这个符号我真的需要吗"，通常答案是"我只需要它携带的数据，不需要它的类型"。

### 读 app.asar 的正确姿势

`app.asar` 是 Electron 的自定义容器，不是 zip。头部结构：

```
[0..4)   uint32 = 4
[4..8)   uint32 = pickle payload size  (= headerSize)
[8..12)  uint32 = 4
[12..16) uint32 = json length
[16..16+jsonLen)  JSON 文件树
文件数据起始 = 8 + headerSize
```

每个文件节点给 `{ size, offset }`，`offset` 是**相对数据区起点**的偏移。
第一版解析器把 headerSize 从 offset 12 读，结果整体错位、JSON 解析炸掉。
正确做法是读 `[4..8)`。


### cordis.patch.yml

```yaml
- insert:
    - id: my-plugin
      name: '@local/dsh-my-plugin'
```

`id` 是后续 `config` 覆盖、`disabled` 开关的锚点。

---

## 2. 命名陷阱

> **不要把 Host 入口命名为 `index.js`。**

内置包（`dsh-workspace`、`dsh-api-workspace-controller` 等）大量使用 `lib/index.js`，
模块解析在 junction / 提取场景下会出现歧义。本插件因此统一改成 `host.js` + `client.js`。

---

## 3. Host 半边

### 最小形态

```js
export const name = 'my-plugin'
export const inject = ['sessionPersistence', 'workspaceRegistry', 'connection']

export function apply(ctx) {
  // 注册能力
}
```

- 用 ESM 命名导出 `name` / `inject` / `apply`，**不要** `export default`。
- `inject` 决定 Host 等你依赖的服务就绪后才 `apply`；少写会导致 `ctx.get(...)` 拿到 `undefined`。

### ⚠️ 最大的坑：控制器的 Remote 调用不到

**已验证**：在插件内部用 `ctx.plugin(MyController)`（继承 `TypertRemoteService`）注册的控制器，
浏览器端调用会直接报：

```
操作失败：this Host does not expose the archived-sessions controller
```

原因：Typert 网关只暴露**根层**控制器的命名空间，嵌套插件注册的不会被识别。

**唯一可靠的宿主能力通道 —— 自己开一条 HTTP 路由：**

```js
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: '/api/myPlugin.action',      // 必须在 /api/ 下，且只有一段后缀
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json()
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  })
}
```

路径规则（都实测过）：

| 写法 | 结果 |
|---|---|
| `/myPlugin/action` | **405**（不在 `/api` 下） |
| `/api/myPlugin/action` | **404**（多段后缀不支持） |
| `/api/myPlugin.action` | ✅ 200 |

- 路由走同源 cookie 鉴权，浏览器端 `fetch(url, { credentials: 'same-origin' })` 即可。
- 桌面版窗口里直接地址栏访问 `/api/...` 会 `401 unauthorized`，那是预期行为（没有会话 cookie），不代表路由坏了。

### 长耗时 / 并发注意

`requestBody: 'buffered'` 表示请求体已读完，handler 里可以安全 `await request.json()`。
handler 抛错不会自动变成 HTTP 错误码，**要自己 try/catch 并返回 `Response`**。

---

## 4. Client 半边

### 执行环境比想象中窄

Client 文件是这样一个工厂，跑在 `window.__ModuleLoader__` 里：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-my-plugin',
  factory(require) {
    const React = require('react')   // ← 只有这一个模块可用
    const h = React.createElement

    function apply(ctx) { /* ... */ }

    return { name: '@local/dsh-my-plugin', inject: ['slots', 'locale', 'workspaces', 'sessions', 'remote'], apply }
  },
})
```

**已验证的约束：**

1. **`require` 只能拿 `react`**。其它包（包括 `@deepseek-ai/*` 的 client）都拿不到。
2. **没有 `styles` 运行时**。写 `styles.insert(...)` 会直接抛 `styles is not defined`，整个插件激活失败。
   样式必须自己插：

```js
const STYLE_ID = 'dsh-my-plugin-styles'
function ensureStyles() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = '@local/dsh-my-plugin'
  style.textContent = CSS
  document.head.appendChild(style)
}
function apply(ctx) {
  ensureStyles()
  ctx.effect(() => () => document.getElementById(STYLE_ID)?.remove(), 'my-plugin: stylesheet')
}
```

3. **不能用模块级 `export const inject`**。
   出口必须在工厂里 `return { name, inject, apply }`。在工厂外写 `export` 会让工厂形态失效，
   表现为插件 `failed` 但**没有任何错误原因**。

### Slot 注册

```js
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-plugin: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'my-plugin',
    order: 25,
    label: () => ctx.locale.bind(NS)('nav'),   // thunk：每次投影都重读，跟随语言切换
    locale: NS,
    inject: () => ({ services: operations }),  // 注入到组件 props
  }, MySection))
}
```

常用 slot（已验证）：`settings.section`。
其它 slot 名以运行时的 `cordis_inspect` 查询结果为准，不要凭记忆写。

### 组件的 props 从哪来

设置页组件收到的是**白名单式**的合成 props，常用：

| prop | 含义 |
|---|---|
| `t(key, params)` | 已绑定本插件 locale 的翻译函数 |
| `locale` | locale 服务，可用 `locale.subscribe` 触发重渲染 |
| `useWorkspaces(selector)` | 工作区快照 hook（`items` / `archivedSessionIds` / `pinnedSessionIds` / `phase`） |
| `useSessions(selector)` | 会话列表快照 hook（`ids` / `byId` / `items` / `phase` / `error`） |
| `services` | 你在 `inject` 里塞进来的操作对象 |

---

## 5. 调试与验证手段

### 5.1 调用 Host RPC（Typert 封包）

```js
const r = await fetch('/api/session/list', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'p1',
    method: 'session/list',          // ← 注意是 "命名空间/方法"，和 URL 路径不同
    payload: { args: { _request: {} } },   // ← args 的字段名要匹配描述符
  }),
})
```

- `method` 字段必须与 `/<ns>/<method>` 完全一致，否则报
  `method "xxx" does not match endpoint "yyy"`。
- `args` 缺少描述符要求的字段会报 `gateway/arguments-invalid: missing "_request"`。

### 5.2 读流式 Remote（`workspace/follow` 这类）

一元接口读不到流式快照（会被拒：`stream Remote methods must be opened through the stream carrier`）。
正确姿势是 **WebSocket 复用通道**：

```js
const ws = new WebSocket(`ws://${location.host}/api/remote.mux`)
ws.onopen = () => ws.send(JSON.stringify({
  type: 'open',
  streamId: 'probe1',
  endpoint: 'workspace/follow',
  payload: { args: {} },
}))
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data)   // { type:'item', streamId, value:{type:'baseline', value:{items,…}} }
}
```

这是排查「Host 认为的工作区内容」和「页面显示的内容」是否一致的**最快手段**。

### 5.3 隔离测试（强烈建议）

**绝不要拿真实数据做破坏性测试。** 做法：

```powershell
$base = "$env:TEMP\arch-test-<随机>"
New-Item -ItemType Directory "$base\profiles" -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop" "$base\profiles\archtest" -Recurse

# 用解包出来的运行时启动（desktop 这个 profile 名被 Electron 独占，必须换名）
$env:DSH_HOME = $base
node <asar解包目录>\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile archtest --no-open --port 0
```

要点：

- **`desktop` 是保留名**，直接 `--profile desktop` 会报
  `profile "desktop" is managed exclusively by the Electron application`，所以复制一份改名。
- `--port 0` 让系统分配端口，启动完成会打印带 token 的 URL。
- 自建的 web profile **没有 `web` 子命令**：直接 `--profile <name> --no-open --port 0`，
  多写一个 `web` 会报 `too many arguments`。
- 要跑 Host 端代码，可用 `plugin_manager` 之外的方式：解包 asar 后从解包目录运行，
  因为真实安装目录下的 `app.asar\dsh` 不能直接 `node` 执行。

### 5.4 直接审计磁盘

很多"UI 不对"其实是磁盘状态不一致，先看盘再看代码：

```powershell
# 账本：归档集合 + 各工作区登记
Get-Content "$env:USERPROFILE\.dsh\storages\workspace.json" -Raw | ConvertFrom-Json

# 日志目录
Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Directory -Filter 'session-*'

# 投影缓存（孤儿检测：有缓存无日志）
Get-ChildItem "$env:USERPROFILE\.dsh\storages\session_projcache\sessions" -Filter '*.json'
```

---

## 6. 会话 / 工作区领域知识（踩坑实录）

### 6.1 工作区 `sessionIds` 是"过滤后视图"

```js
get sessionIds() {
  return this.record.sessionIds.filter((id) => this.host.candidateMatches(id, this.record.path))
}
```

`candidateMatches` 依赖启动时建立的**头索引**：只要注册表里还记着这个 id，即使日志文件已删，
它**仍然算属于该工作区**。

**后果：**
- 判断"会话是否归属某工作区"时，用 `workspace.sessionIds.includes(id)` 会漏判（该 id 已被过滤掉，返回 false）。
- 要真正清理，必须遍历原始账本按 id 判断，不能依赖这个 getter。

### 6.2 侧边栏「未分组」不参考归档集合

侧边栏分组逻辑（`dsh-client-ui-workspace/client.js` 的 `ungroupedMemberIds`）：

```js
const accounted = new Set(workspaces.flatMap(w => w.sessionIds))
return list.ids.filter(id => list.byId[id] !== undefined && !accounted.has(id))
```

**归档集合完全没参与。** 因此任何"既不在工作区、又不在归档集合"的行都会落到「未分组」并渲染出来。

`deriveGroups` / `groupByWorkspace` 里才会按 `sessionVisible(...)` 过滤归档，
但那条路径只处理**已被某工作区登记**的成员。

**这是 harness 本身的设计缺口，插件只能规避，不能真正修好。**

### 6.3 删除日志后，前端仍留着一行

**根因链（已验证）：**

1. `handleSessionRemoved(id)` 走的是**列表变更通道** `recordMutation`；
2. 变更只在 `manager.listMutations` 窗口开启时才被写进 `summaries`；
3. 删除流程 `purge → refresh()` 会把窗口替换掉，**变更被丢弃**；
4. 于是该行仍在 `summaries` 里 —— 而它已不在工作区、不在归档集合 → 掉进「未分组」。

**正确的清除方式：直接删记录**（按 id 索引，后续任何拉取都无法把它加回来）：

```js
const forget = (sessionId) => {
  const manager = sessions.manager ?? sessions
  if (Array.isArray(manager.summaries)) {
    manager.summaries = manager.summaries.filter((s) => s.sessionId !== sessionId)
  }
  if (Array.isArray(manager.listMutations)) {
    manager.listMutations = manager.listMutations.filter((m) => m.sessionId !== sessionId)
  }
  manager.entryCache?.delete?.(sessionId)
  manager.projectionStores?.delete?.(sessionId)
  sessions.handleSessionRemoved?.(sessionId)   // 补一条变更，覆盖其它订阅者
}
```

删除流程应为：`purge → forget → refresh → 再 forget 一次`
（覆盖 refresh 期间基线又把行塞回来的情况）。

> 这依赖 `sessions.manager` 的内部字段，属于**跨版本易碎**的写法。
> 调用前务必做 `typeof === 'function'` / `Array.isArray` 判空，失败就退化为只调 `handleSessionRemoved`。

### 6.4 别用 "session 是否 mounted" 判断占用

归档**不会**卸载 Agent：归档只通过 `agent/pre-step` 网关阻止继续跑步骤，
Agent 仍可能挂在内存里。

所以「该会话正在运行，请先结束它再删除」这类误报的根源是判断方式错了。
**正确的判据是"文件是否真的被占用"**：

```js
// 打开日志只读；能打开就说明可删（写锁才会抛 SessionAlreadyOwnedError）
try { handle = await persistence.open(sessionId, 'read') }
catch (e) { if (e?.name === 'SessionAlreadyOwnedError') return { reason: 'busy' } }

// 兜底：真正 rm 时命中 EBUSY/EPERM/EACCES 才算占用，并把墓碑改名回滚
```

### 6.5 删除要清三样东西

删一个会话，必须同时清理：

| 位置 | 内容 |
|---|---|
| `~/.dsh/sessions/--<projectKey>--/<id>/` | 会话日志（可能有多代 `session.vN.jsonl.zstd`） |
| `~/.dsh/storages/workspace.json` | `archivedSessionIds` + 各工作区 `sessionIds` |
| `~/.dsh/storages/session_projcache/sessions/<id>.json` | 投影缓存（**最容易忘**） |

漏掉最后一项不会立即出问题（Host 列表只枚举磁盘日志），但会持续堆积孤儿文件。

### 6.5.1 子智能体会话是第四样，而且永远看不见（已验证）

子智能体的会话是**独立的会话目录**，和主会话平级，靠日志头里的两个字段认亲：

```json
{"type":"session","id":"fb59faaf-…","parentSession":"session-52da7cc8-…",
 "origin":"subagent","delegationDepth":1,"agentPreset":"code-advisor"}
```

**关键：侧边栏永远不显示它们。** `dsh-client-ui-workspace/lib/client.js` 的
`sessionVisible()` 第一行就是：

```js
if (session.origin === "subagent") return false;
```

所以删掉主会话后留下的子会话是**纯磁盘垃圾**：不进侧边栏、不进「未分组」、
不会被任何 UI 路径碰到，只会一直占着盘。实测本机 default-workspace 里，
11 个主会话旁边躺着 18 个子会话，其中 9 个的父会话已经不存在了（583 KB）。

其它要点：

- 子会话的 project 目录由**它自己的 `cwd`** 决定（`projectKey(cwd)`），不一定和父会话同目录。
  所以按父会话的 project 目录去找子会话会漏，必须扫整个 root。
- 日志头是**第一行**，且只在创建时写一次。zstd 日志是「多帧拼接」容器，
  头独占第一帧，`zstdDecompressSync` 解前 16 KiB 就能拿到（截断到帧边界是合法的）。
  读整份文件没必要。
- 原生列表本身**有**父子概念（`list.js` 输出 `parentSessionId`，
  `lineage.js` 的 `flattenLineage` 会做缩进），父会话缺失时孤儿**降级成根节点**而不是丢弃。
  但那是会话列表的数据，侧边栏那层已经先把 subagent 过滤掉了。
- 持久化层认子会话也是同一个判据，可对照 `dsh-session-persistence-jsonl` 的
  `prepareStoredMigration()`：
  `source.header.origin === "subagent" && source.header.parentSession === id`。

**归档守卫不能套在子会话上。** `purgeSession` 要求 id 在 `archivedSessionIds` 里，
但子会话根本没机会被归档（侧边栏不显示它，就没有归档入口）。
所以级联删除必须把「归档校验」和「删一个会话」拆成两层：外层校验用户选的那个 id，
内层 `purgeOneSession()` 不加守卫，供子会话复用。

### 6.6 日志目录命名

后端用 `encodeSegment(sessionId)`：`[A-Za-z0-9._-]` 原样保留，其余字符（含 `~` 本身）编码成 `~XXXX`
（大写十六进制 UTF-16 单元），`.` → `~002E`，`..` → `~002E~002E`。
不要自己拼路径，照抄这个规则才能定位到目录。

### 6.7 Windows 上别信 `Dirent.isDirectory()`

某些文件系统上 `readdir` 返回的类型不可靠。扫描会话目录时要**实际 probe**（`readdir(dir)` 能否成功），
不要靠 `isDirectory()` 跳过，否则会漏掉真实目录（我因此得到过 `removedLog: false` 的假结果）。

---

## 7. 生命周期

| 改动 | 生效方式 |
|---|---|
| `client.js` | 热更新，刷新页面即可 |
| `host.js` / `package.json` / `cordis.patch.yml` | **必须重启 DSH 进程** |
| 插件整体安装 | `plugin_manager install_bundle`（profile 里以 junction 链接） |

改了 Host 端却"没反应"时，第一件事永远是确认进程是不是还是老的。
排查方法：看监听端口对应的进程 `StartTime` 是否早于文件修改时间。

---

## 8. 排查清单（遇到"UI 不对"时按顺序走）

1. **先看盘**：`workspace.json` 的归档集合、工作区登记、日志目录、投影缓存四者是否自洽。
2. **再看 Host**：用 `workspace/follow`（WebSocket）读 Host 真实认为的分组，和界面比对。
3. **最后看前端快照**：`useSessions` 里是否残留 id —— 残留就是"未分组"的元凶。
4. **确认进程版本**：改了 Host 没重启，白排查。
5. **确认是旧页快照**：重启前打开的标签页可能仍持有旧数据，刷新一次再判断。

---

## 9. 仍然没把握的部分（不要当经验用）

- Host 端没有稳定的日志出口，目前只能靠行为与磁盘状态反推，排查效率低。
- 只实践过「设置页 + 一条 HTTP 路由」这一种形态；页面级 slot、命令、工具、MCP 连接均未验证。
- `sessions.manager` 内部字段（`summaries` / `listMutations` / `entryCache` / `projectionStores`）
  是**非公开契约**，升级后可能改名，代码里必须有降级路径。
