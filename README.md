# dsh-autoload

> 一键加载 DeepSeek Harness 会话的全部历史。点一下，把「加载更早」按到底。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的会话是分页加载的：打开一个长对话，消息列表顶端只有一个「加载更早」按钮，**点一次只往前翻一页**。195 轮、2000+ 步的会话，要手动点两三百次才能回到开场。

这个插件把这件事变成一个按钮。

---

## 它做什么

| | |
|---|---|
| **浮标** | 会话右下角一枚「⇡ 全量加载」，点一下开始连续翻页，运行中再点一下停止 |
| **快捷键** | `Ctrl+Alt+Home` 开始/停止 · `Ctrl+Alt+End` 回到底部 |
| **进度** | 浮标实时显示已翻页数（`⇡ 42…`），完成后转「✓ 已到最早」并滚到会话顶部 |
| **安全阀** | 1000 次点击上限；连续 40 轮无进展判定卡住自动停手 |
| **诊断** | `GET /dsh-autoload/status` 保留最近 5 次运行记录（次数 / 耗时 / 状态） |

实测：一个 233 页的会话，61 秒翻完，平均 **262 ms/页**（其中约 200 ms 是宿主自己加载那一页的时间）。

---

## 安装

插件是标准的 DSH cordis bundle + 客户端 bundle 双半边结构。

### 1. 放进 profile

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"   # 或 web
git clone <this-repo> "$env:USERPROFILE\.dsh\plugins\dsh-autoload"

# 建链接（Windows junction，源码改动即时生效）
New-Item -ItemType Junction -Path "$profileDir\node_modules\dsh-autoload" `
         -Target "$env:USERPROFILE\.dsh\plugins\dsh-autoload"
```

### 2. 登记依赖与启用清单

`$profileDir\package.json` 追加两处：

```jsonc
{
  "dependencies": { "dsh-autoload": "link:<上面的源码绝对路径>" },
  "dsh": { "profile": { "bundles": [ /* … */, "dsh-autoload" ] } }
}
```

### 3. 让 lockfile 认识它（**不要跑完整 install**）

```powershell
cd $profileDir
pnpm add "dsh-autoload@link:<源码绝对路径>" --lockfile-only
```

> ⚠️ **必须带 `--lockfile-only`**。
> 完整 `pnpm install` 在 `nodeLinker: hoisted` 的 profile 上会走「重建整个 node_modules」的路径，把正在被宿主进程占用的插件包一并删掉，轻则插件全部失效，重则 GUI 起不来。`--lockfile-only` 只写 lockfile 与 package.json，不碰 node_modules（输出里是 `added 0`）。

### 4. 启用

```powershell
$b = @{ name='dsh-autoload'; enabled=$true } | ConvertTo-Json
Invoke-WebRequest "http://127.0.0.1:<DSH端口>/dsh-market/toggle" -Method POST `
  -Body $b -ContentType application/json -Headers @{Origin="http://127.0.0.1:<DSH端口>"}
```

或者直接在 DSH 的插件市场页里打开它。

### 5. 重启 DSH

客户端 bundle 由宿主在启动时注入，**`Ctrl+R` 在桌面端不生效**，要重启客户端（托盘退出→重开）才能加载新代码。

---

## 卸载 / 回滚

```powershell
# 禁用（立即生效，不用删文件）
$b = @{ name='dsh-autoload'; enabled=$false } | ConvertTo-Json
Invoke-WebRequest "http://127.0.0.1:<端口>/dsh-market/toggle" -Method POST `
  -Body $b -ContentType application/json -Headers @{Origin="http://127.0.0.1:<端口>"}

# 彻底移除
Remove-Item "$profileDir\node_modules\dsh-autoload"
# 再从 package.json 的 dependencies / bundles 里删掉那两行
```

---

## 实现

**纯 DOM 操作，不碰宿主内部 API。** 「连续翻页」等价于用户自己手点 N 次，宿主改版也不容易崩。

```
lib/index.js    服务端：只提供 /dsh-autoload 诊断路由（ping / status / report）
lib/client.js   客户端：浮标 UI、按钮查找与连点、快捷键、MutationObserver 刷新
```

### 关键实现点

1. **按钮定位**：`[data-conversation-scroll]` 容器内，文案匹配 `加载更早 / 加载更多 / 加载中 / Load earlier / Loading`
2. **性能**：先 `querySelector('button')` 取第一个（「加载更早」永远在列表最上方），命中即用；同时缓存按钮引用，`disabled` 轮询期间不做整棵树扫描。这一步把单页耗时从 452 ms 降到 262 ms —— 长会话 DOM 里有几千个 `button`，每次全量扫描的代价比翻页本身还大
3. **等待策略**：`readyPollMs: 40`（等按钮从「加载中」恢复可用）+ `clickGapMs: 60`（两次点击最小间隔），而不是固定 sleep
4. **不打断阅读**：点一次就 `await` 一次宿主自己的分页，页面位置由宿主维护，不会乱跳

---

## 踩坑记录：v0.1.0 曾把 GUI 卡死在 "Loading plugins…"

第一版写完直接启用，结果 DSH 界面无限转圈，只能禁用才恢复。原因有两个，都记在这里给后来者：

### ① 声明了一个不存在的客户端依赖

```jsonc
"dsh.client": {
  "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection"]
}
```

`@deepseek-ai/dsh-client-runtime` 在这个宿主版本里**根本不存在**（扫遍 `app.asar` 18188 个条目都没有）。前端启动逻辑是：

```js
await e.modules.entries.start(n, r);
await n.await();          // ← 有 entry 永远 pending 就在这里死等
```

一个等不到服务的 entry 会让整个 boot 永远不 settle，界面只剩转圈。

**修**：`inject: []`。这个插件不消费任何宿主服务，零依赖最安全。

### ② 挂载时机太早

`apply()` 里第一行就 `document.body.appendChild(...)`，此时 `body` 可能还是 `null`。

**修**：`apply()` 立即返回，DOM 就绪交给 `setTimeout` 轮询（最多 80 秒），就绪后再挂载。

### ③ MutationObserver 自触发循环

监听整个 `body`，而渲染函数每次都写 `textContent` —— 写 DOM 又触发自己的 observer。

**修**（三道闸）：
- observer 回调里跳过浮标自身子树（`pill.contains(m.target)`）
- `paint()` 幂等：记 `painted` 快照，值没变就不写 DOM
- 多次变更用 `requestAnimationFrame` 合并成一帧一次

### ④ 服务端与客户端的更新时机不同

- 客户端 `lib/client.js`：浏览器每次刷新重新拉，改完刷新即可
- 服务端 `lib/index.js`：ESM 模块有进程内缓存，**禁用再启用也不会重载**，必须重启 DSH

---

## 测试

`.test/smoke.cjs` 用最小 DOM stub（自写 El / MutationObserver / fetch）跑真实的 `lib/client.js`，17 项断言：

```powershell
node .\.test\smoke.cjs
```

覆盖：apply 不抛错且立即返回、body 未就绪时不崩、就绪后正确挂载、浮标文案按状态切换、observer 忽略自身变更、20 次外部变更不重复写 DOM、`dispose` 后元素/监听器清理干净且 2.5 秒内不复活。

---

## 已知限制

- **单个会话**：只处理当前打开的会话，不会跨会话批量加载
- **速度上限由宿主决定**：每页约 200 ms 是宿主的加载时间，插件只占约 60 ms
- **完成后滚顶需要一次布局**：加载结束时设置 `scrollTop = 0`，若虚拟列表尚未重排，可能需要轻微滚动一次才跳到真正的顶部
- **按钮文案依赖**：靠文案匹配定位按钮，宿主改文案、或新增语言时需要同步更新 `BTN_TEXT`

---

## License

MIT
