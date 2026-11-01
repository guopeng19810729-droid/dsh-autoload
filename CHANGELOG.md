# Changelog

所有改动按 [Conventional Commits](https://www.conventionalcommits.org/) 归类。

## v0.2.1 — 2026-11-01

### fix
- **性能**：`findButton()` 不再每次全量扫描 `[data-conversation-scroll]` 下所有 `button`。长会话 DOM 里有几千个按钮，全量扫描是翻页耗时的大头。改为：缓存按钮引用（`isConnected` 复用）+ 快速路径 `querySelector('button')` 取第一个，文案不符才回退全量扫描。
  - 实测：单页 452 ms → **262 ms**（233 页的会话，总耗时仍约 61 秒 —— 剩余时间主要是宿主自己的分页加载）
- **等待策略**：固定 `intervalMs: 150` 拆成 `readyPollMs: 40`（等按钮从「加载中」恢复）+ `clickGapMs: 60`（两次点击间隔）

### feat
- 服务端 `/dsh-autoload/status` 新增 `runs` 数组，保留最近 **5 次**运行记录（`clicks` / `found` / `durationMs` / `status` / `reason`），不再只留最后一条
  - 之前刚跑完 81 次的那条记录，会被紧接着的第二次点击覆盖

## v0.2.0 — 2026-11-01

### fix
- **修复 GUI 卡死在 "Loading plugins…"**：
  - `dsh.client.inject` 从 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection"]` 改为 `[]`。前者在当前宿主版本里不存在，会导致 entry 永远 pending，前端 `await n.await()` 不返回
  - `apply()` 立即返回，DOM 就绪交给轮询处理，不再阻塞宿主启动
- **修复 MutationObserver 自触发循环**：observer 跳过浮标自身子树、`paint()` 幂等（值不变不写 DOM）、`requestAnimationFrame` 合并刷新
- **dispose 完整化**：清理 DOM 等待定时器、心跳、rAF、observer、快捷键监听、浮标与样式，并在 `disposed` 后拒绝任何重新挂载
- 异常不再静默吞掉：所有回调 `console.error` 留因（`fetch` 上报失败用 `console.debug`，宿主路由缺失属常态）

### test
- 新增 `.test/smoke.cjs`：最小 DOM stub 跑真实客户端代码，17 项断言全过

## v0.1.0 — 2026-11-01

### feat
- 初版：会话右下角浮标「⇡ 全量加载」，自动连点「加载更早」直到加载完
- `Ctrl+Alt+Home` 开始/停止 ｜ `Ctrl+Alt+End` 回到底部
- 完成后自动滚到会话顶部，浮标转「✓ 已到最早」
- 服务端 `/dsh-autoload/{ping,status,report}` 诊断路由

### known issues
- 启用后 GUI 卡死在 "Loading plugins…"（v0.2.0 修复）
