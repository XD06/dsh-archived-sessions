# 归档会话彻底删除后，Host 仍返回该会话（「未分组」幽灵行）

> 状态：**已修复并验证通过**
> 适用版本：DeepSeek Harness `0.2.1-rc.2`（Windows 桌面版 / Web UI）
> 相关插件：`@local/dsh-archived-sessions`（本地自建，位于 `archived-sessions/`），修改文件 `host.js`

---

## 0. 修复结论（先看这里）

根因不是磁盘残留、不是 pending 残留、也不是前端快照，而是**两个进程内注册表仍然持有该会话**：

1. `agents` 注册表（`AgentsService.store`）——归档只拦截 `agent/pre-step`，从不卸载 Agent；
2. `sessions` 存储（`SessionService.store`）——`session-query.listSessions()` 会把它折叠进列表。

修复方式见 §5，实测结果：

```
A) 未归档会话调用删除 → 被拒绝，会话完好
   { status: 500, code: "archived-sessions/not-archived" }  survived: true

B) 归档 → 删除，连跑 3 轮
   round0  deleted:true  retired:true  stillListed:false
   round1  deleted:true  retired:true  stillListed:false
   round2  deleted:true  retired:true  stillListed:false
```

---

## 1. 现象

在「设置 → 归档会话」里对一个归档会话执行**彻底删除**后：

1. 磁盘上的会话日志确实被删除了（已验证）；
2. `~/.dsh/storages/workspace.json` 里的归档标记和工作区账本也清理干净了（已验证）；
3. **但侧边栏仍出现一行该会话，落在「未分组」分组下**；
4. 该行可以点击，但打开必然失败（没有日志）；
5. **重启 DSH 后消失**，但**再删一个归档会话，又会新出现一条**；
6. 刷新页面**无效**。

---

## 2. 关键证据

在隔离环境（独立 `DSH_HOME` + 复制 profile）中复现，步骤如下：

1. 创建会话（不写入任何消息）；
2. 直接删除它的磁盘日志目录；
3. 把它从 `workspace.json` 的工作区账本中移除；
4. 调用 Host 观察状态。

观察结果：

```jsonc
// 后台 JSONL 持久化的 pending 表
"trackerOf=pending.size=0 keys=[]"
"listPendingCreations=[]"

// 工作区账本
"registry.list.length=1"   // 且该工作区内已不含此 id

// 但 session/list 仍返回它，且：
{
  "id": "session-453f23be-...",
  "blank": true,
  "agentAvailable": true,      // ← 有活的 Agent 持有
  "formatStatus": "current",   // ← 被当作「当前格式的活会话」
  "cwd": "<workspace-path>"
}
```

**决定性结论：`agentAvailable: true` 说明该会话在 `ctx.agents` 注册表里还挂着一个活 Agent。**

它不是磁盘残留（磁盘已清）、不是 pending 残留（pending 为空）、也不是账本残留（账本已清）。

---

## 3. 根因链条

### 3.1 列表为什么还会返回它

`@deepseek-ai/dsh-api-session-controller/lib/types/list.js` 的 `list()`：

```js
async list(signal) {
  const records = await this.ctx.sessionQuery.listSessions(signal)
  const items = []
  const cold = []
  for (const record of records) {
    const live = this.ctx.sessions.get(record.header.id)
    if (live !== undefined) {
      items.push(this.summaryFor(live))          // ← 活会话：从 live session 投影
    } else if (record.header.cwd !== undefined) {
      cold.push(record)                          // 冷会话：从持久化记录摘要
    }
  }
  for (const record of cold) items.push(this.summarizeCold(record))
  ...
}
```

`sessionQuery.listSessions()` 的数据源包含「磁盘工件 + pending 创建」。
两者都已为空，所以这一行**只能来自 `ctx.sessions.get(id)` 命中的活会话路径**。

`summaryFor()`（同文件）里：

```js
agentAvailable: this.ctx.agents.get(session.id)?.session === session,
formatStatus: 'current',
```

`agentAvailable: true` 与实测输出完全吻合。

### 3.2 Agent 为什么还挂着

归档机制本身**不卸载 Agent**。`@deepseek-ai/dsh-api-session-controller/lib/types/archived-session-gate.js` 全文逻辑：

```js
export const ArchivedSessionGate = {
  name: 'archived-session-gate',
  inject: ['agents', 'sessions', 'workspaceRegistry'],
  apply(ctx) {
    ctx.on('agent/pre-step', (payload, next) =>
      underArchivedSession(ctx, payload.agent)
        ? Promise.resolve({ kind: 'reject' })
        : next())
  },
}
```

它只拦截「下一步执行」，Agent 对象依然在 `agents` 注册表里。
归档之后日志被删除，这个 Agent 就变成一个**没有后端存储的活会话**。

### 3.3 为什么落到「未分组」

`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`（约 3545 行）：

```js
const ungroupedMemberIds = useMemo(() => {
  const accounted = new Set(workspaces.flatMap((w) => w.sessionIds))
  return list.ids.filter((id) => list.byId[id] !== undefined && !accounted.has(id))
}, [list, workspaces])
```

两个事实叠加：

- 该判定**完全不参考 `archivedSessionIds`**；
- 工作区的 `sessionIds` getter 会经 `candidateMatches` 过滤（`@deepseek-ai/dsh-workspace/lib/index.js` 约 102 行），日志没了就不再算归属。

于是它「不在任何工作区、也不在归档集合」，直接被画进「未分组」。

### 3.4 为什么重启能好

Agent 注册表（`AgentsService.store`）是**进程内存**的 `Map`。进程重启即清空。

---

## 4. 已尝试且无效的修法

| 修法 | 结果 |
|---|---|
| 删除后清工作区账本 + 归档标记 | 有效但不足，行仍在 |
| 删除后清投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json` | 有效但不足 |
| 前端 `forget`：直接删 `manager.summaries` 记录 + 调 `handleSessionRemoved` | 只治当前页，Host 下次拉取又回来 |
| 清 `JsonlBackendTracker.pending` 内存记录 | **无效**，实测 pending 本就是空的 |
| 只从 `agents` 注册表摘除条目 | 有进展但不彻底：`agentAvailable` 变为 `false`，行仍在（见 §5.1） |
| 刷新页面 | 无效 |
| 重启 DSH | 有效，但只是掩盖，删下一个又复现 |

---

## 5. 修复（已实施）

### 5.1 关键发现：`session/list` 有两个活数据源

第 3 节只查了 `agents`，实测发现**光移除 agent 还不够**。`@deepseek-ai/dsh-session-query/lib/index.js` 的 `listSessions()`：

```js
async listSessions(signal) {
  const persisted = persistence === void 0 ? [] : await listPersisted(persistence, signal)
  const records = new Map()
  for (const { header, formatStatus } of persisted) records.set(header.id, { header, live: false, persisted: true, formatStatus })
  for (const session of this._ctx.sessions.list()) {          // ← 第二个来源
    records.set(session.id, { header: structuredClone(session.header), live: true, persisted: durable !== void 0, formatStatus: 'current' })
  }
  return [...records.values()].sort(compareSessions)
}
```

也就是说列表 = **磁盘工件 + pending 创建 + `ctx.sessions.list()`**。
只删 agent 后，该行仍在，只是 `agentAvailable` 从 `true` 变成 `false` —— 这是定位过程中的关键分水岭。

### 5.2 实施方式（`host.js`）

新增 `retireAgent(ctx, sessionId, { dryRun })`：

1. `ctx.get('agents').get(id)` 拿到 agent；不存在则直接返回成功（幂等）；
2. `agent.status === 'running'` → 拒绝（`running`），不打断用户正在跑的任务；
3. `sessions.retainedBy(id) > 0` → 拒绝（`in-use`），不拆正在被页面使用的会话；
4. `agent.scope.rawDispose()` → 触发 agent loop 的 teardown，正常路径下会依次执行
   `machine.scope.dispose()` → `detachAgent()`（`agents.enter()` 返回的注销闭包）→ `detachSession()`；
5. **兜底**：若 teardown 因某种原因没把条目摘掉（实测确实如此），直接删两个 store 的确切条目，
   并校验 entry 身份，避免误删复用了同一 id 的其它 agent/session：
   - `agents.store.get(id).agent === stillLive` → `agents.store.delete(id)`
   - `sessions.store.delete(id)`，同时同步 `sessions.attachments`

`purgeSession()` 的顺序：

```
① 校验必须处于归档集合（否则 RemoteError archived-sessions/not-archived）
② retireAgent(dryRun:true) 预检 running / in-use → 命中则返回 busy（此时还没删任何东西）
③ 删除日志目录（rename → rm，保留可重试的墓碑语义）
④ 清归档标记 + 工作区账本
⑤ 清投影缓存
⑥ 清 pending 创建记录
⑦ retireAgent() 真正注销两个注册表
```

### 5.3 为什么要有「必须先归档」的前置校验

测试中发现一个真实风险：**原实现不校验归档状态**。
直接对任意 sessionId 调用删除路由，会把一个正常的活会话也拆掉（日志已无、Agent 被 retire）。
现在在入口处拦住，返回 `archived-sessions/not-archived`。

### 5.4 读取 Service 内部字段的正确姿势

`ctx.get()` 返回的 Service 是 traceable proxy：任何未在 `inject` 中声明的字符串属性
都会抛 `cannot get property "…" without inject`，`Object.values()` 也会触发。

正确做法：

```js
const raw = service?.[Symbol.for('cordis.original')] ?? service
// 用 descriptor 读字段，避免 proxy getter 把 Object.prototype 的描述符当作命中
const value = Reflect.getOwnPropertyDescriptor(raw, key)?.value
```

注意 `cordis.original` 只需解开一次——`tracker`、`store` 这类具体实例是普通对象，不是 proxy。

---

## 6. 复现与测试环境注意（非常重要）

### 6.1 插件必须是链接，不能是副本

复制 profile 时会把插件目录**整体复制**，之后改 `host.js` 不会生效，测试会一直跑旧代码（本次排查因此多绕了几轮）。

```powershell
$link = "<临时DSH_HOME>\profiles\<profile>\node_modules\@local\dsh-archived-sessions"
Remove-Item $link -Recurse -Force
New-Item -ItemType Junction -Path $link -Target "<插件源码目录>" | Out-Null
```

### 6.2 其它坑

- `--profile desktop` 被 Electron 独占，测试必须复制一份并改名；
- 自建 web profile **没有 `web` 子命令**，直接 `dsh --profile <name> --no-open --port 0`；
- 安装目录下的 `app.asar\dsh` 不能直接 `node` 执行，需先解包。

---

## 7. 关键代码位置

```
插件（已修复）:
  archived-sessions/host.js   ← retireAgent / purgeSession / dropMissingSessions / prunePendingCreations
  archived-sessions/client.js ← 设置页 UI
  archived-sessions/PLUGIN-NOTES.md ← 插件开发踩坑笔记

被测模块（均在 app.asar 内）:
  @deepseek-ai/dsh-api-session-controller/lib/types/list.js                列表合并逻辑
  @deepseek-ai/dsh-api-session-controller/lib/types/archived-session-gate.js  归档闸门（只拦 pre-step）
  @deepseek-ai/dsh-agent/lib/index.js                                     AgentsService（enter / detachEntered / store）
  @deepseek-ai/dsh-agent-loop/lib/index.js                                Agent 构造与 scope（约 778、1746 行 teardown）
  @deepseek-ai/dsh-session/lib/index.js                                   SessionService（enter / detachEntered / store）
  @deepseek-ai/dsh-session-query/lib/index.js                             listSessions()：磁盘 + ctx.sessions.list()
  @deepseek-ai/dsh-workspace/lib/index.js                                 sessionIds getter（过滤）
  @deepseek-ai/dsh-client-ui-workspace/lib/client.js                      「未分组」算法（约 3545 行）
  @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js                 list() 合并 pending / encodeSegment
```

---

## 8. 诊断接口（插件已内置）

```http
POST /api/session.purgeArchived
{"action":"diagnose"}
```

返回：

- `service / raw` 的字段清单与原型链
- 各候选对象的 `pending` 属性描述符
- `trackerOf=pending.size=…`
- `listPendingCreations=[…]`
- `registry.list.length=…`

其它可用动作：

- `{"action":"prune"}` — 清理归档集合里日志已消失的 id
- `{"action":"prunePending"}` — 清理无日志、无账本、无活 Agent 的未落盘创建
- `{"action":"sweep","sessionIds":[…]}` — 按 id 对账并清理
- `{"sessionId":"…"}` — 执行一次彻底删除；**该 id 必须处于归档集合**，否则返回
  `archived-sessions/not-archived`。成功响应包含：

```jsonc
{
  "deleted": true,
  "sessionId": "session-…",
  "pending": false,
  "removedLog": true,       // 磁盘日志已删除
  "removedCache": true,     // 投影缓存已删除
  "removedPending": false,  // 内存 pending 创建已清除
  "retiredAgent": true,     // agents + sessions 两个注册表条目已注销
  "bytes": 347,
  "removedChildren": ["…"], // 一并删掉的子智能体会话（无子会话时字段不出现）
  "childrenFailed": ["…"]   // 没能删掉的子会话（忙/被占用），父会话删除不受影响
}
```

忙碌时返回 `{"deleted": false, "reason": "busy", "busyBecause": "running" | "in-use"}`。

---

## 9. 子智能体会话不会被级联删除（已修复）

### 9.1 现象

删除一个主会话后，`~/.dsh/sessions/<project>/` 下仍留着它的子智能体会话目录。
实测本机 default-workspace：11 个主会话旁躺着 18 个子会话目录，其中 **9 个的父会话已彻底不存在**，
合计 583 KB。这些目录**在 UI 上完全不可见**，也没有任何引用指向它们。

### 9.2 为什么 UI 上看不见

`dsh-client-ui-workspace/lib/client.js` 的 `sessionVisible()` 第一行：

```js
if (session.origin === "subagent") return false;
```

子智能体会话在侧边栏被**无条件过滤**。所以孤儿既不会进「未分组」，也不会被用户发现，
只会静默堆积。（注意这和 §3.3 的「未分组」是两回事：那条是主会话的幽灵行。）

### 9.3 根因

`purgeSession()` 只删 `locateSessionDirectory(ctx, sessionId)` 定位到的**那一个**目录，
全程没有读 `parentSession`，子会话无人通知。

子会话的判据在日志头（第一行）：

```json
{"type":"session","id":"…","parentSession":"session-…","origin":"subagent","delegationDepth":1}
```

持久化层自己也是这么认的（`dsh-session-persistence-jsonl` 的 `prepareStoredMigration()`）：

```js
const children = async () => (await this.listArtifacts(signal))
  .filter((source) => source.header.origin === "subagent" && source.header.parentSession === id);
```

### 9.4 修复

`host.js` 拆成两层 + 一次扫描：

1. `indexSessionParents(ctx)` — 扫一遍会话 root，建 `parentSession → [childId]` 索引。
   必须扫整个 root，因为子会话的 project 目录由**它自己的 `cwd`** 决定，可能和父会话不同目录。
2. `collectSessionLineage(ctx, rootId)` — 基于索引做 BFS，父在前、子在后，去重，
   深度上限 `DELEGATION_MAX_DEPTH = 16` 防环。
3. `purgeSession()` — 保留**归档守卫**（只校验用户选中的那个 id），先收集后删除；
   父会话成功后逐个删子会话，失败的记进 `childrenFailed`，不推翻父会话的删除。
4. `purgeOneSession()` — 真正干活的内部函数，**不加归档守卫**。
   必须拆开：子会话在侧边栏不可见 → 无法被归档 → 若沿用守卫，级联删除永远失败。

关键语义（已测）：

- **父会话忙 → 整体不动**，子会话一个都不删（否则会拆掉用户还开着的会话的子会话）；
- 父空闲、某个子会话忙 → 父照删，该子会话保留并出现在 `childrenFailed` 里；
- 无子会话时，`removedChildren` / `childrenFailed` 字段不出现（不污染既有响应）。

### 9.5 日志头读取

只读第一帧，不读整个文件：zstd 日志是多帧拼接容器，头独占第一帧，
`zstdDecompressSync` 读 16 KiB 截断到帧边界即可解码（截断到帧边界是合法的）。
同时兼容 `.jsonl`（v0 纯文本）和 `.jsonl.zstd` 两代格式。
本机 37 个真实日志实测全部解析成功。

### 9.6 测试

离线桩测试（临时目录 + 假 ctx，不碰真实 `~/.dsh`）覆盖 17 项断言，全部通过：
跨项目目录级联、隔代级联、纯文本日志、无关会话不受影响、归档守卫、
父忙阻断级联、子忙单独报告、无子会话时字段省略。


