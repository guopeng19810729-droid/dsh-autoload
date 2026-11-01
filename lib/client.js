/**
 * dsh-autoload — 客户端（Web 半边）v0.2.0
 *
 * 做的事：把会话顶部的「加载更早」按钮自动连点到底。全部动作都是纯 DOM
 * 点击，等价于用户自己手点 N 次，不碰宿主内部 API。
 *
 * 入口：
 *   - 会话右下角浮标「⇡ 全量加载」，点一下开始，运行中再点一下停止
 *   - Ctrl+Alt+Home（Mac ⌘+⌥+Home）开始/停止；Ctrl+Alt+End 回到底部
 *
 * ── v0.2.0 修复（针对 v0.1.0 卡死 GUI 的问题） ──────────────────────────
 * 1. package.json 的 dsh.client.inject 改为 []：宿主 asar 里没有
 *    @deepseek-ai/dsh-client-runtime，entry 会一直 pending，前端
 *    `await n.await()` 不返回 → 界面卡在 "Loading plugins…"。
 * 2. apply() 立即返回，DOM 就绪交给轮询处理，绝不让宿主等它。
 * 3. 异常不再静默吞掉：console.error 留因，并清理已创建的资源。
 * 4. dispose 完整：取消 DOM 等待、定时器、rAF、监听器，移除按钮与样式，
 *    并在标记 disposed 之后拒绝任何重新挂载。
 * 5. 修掉 MutationObserver → paint() → MutationObserver 的自触发循环：
 *    - observer 忽略浮标自身子树内的变更；
 *    - paint 幂等，文案/状态没变就不写 DOM；
 *    - 多次变更用 requestAnimationFrame 合并成一次刷新。
 */
window.__ModuleLoader__.load({
  id: 'dsh-autoload',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const TAG = '[dsh-autoload]'
    const REPORT_URL = '/dsh-autoload/report'
    const SCROLL_SELECTOR = '[data-conversation-scroll]'
    const BTN_TEXT = /(加载更早|加载更多|加载中|load\s*earlier|loading)/i

    const cfg = {
      readyPollMs: 40,        // 等「加载中」按钮恢复可用的轮询粒度
      clickGapMs: 60,         // 两次点击之间的最小间隔
      maxClicks: 1000,        // 保险上限
      stallTicks: 40,         // 连续空转次数判定卡住
      scrollTopAtEnd: true,   // 完成后滚到最顶
      reportEvery: 10,        // 每 N 次点击回传一次
      domPollMs: 200,         // 等 document.body 的轮询间隔
      domPollTries: 400,      // 轮询上限（约 80 秒）
      heartbeatMs: 2000,      // 浮标被移除时补挂的心跳
    }

    const state = {
      running: false,
      clicks: 0,
      found: 0,
      status: 'idle', // idle | running | done | stopped | timeout | no-button
      startedAt: 0,
      endedAt: 0,
      error: '',
    }

    /** 所有需要回收的句柄集中一处，dispose 不会漏。 */
    const res = {
      disposed: false,
      pill: null,
      label: null,
      style: null,
      observer: null,
      domTimer: null,
      heartbeat: null,
      paintRaf: null,
      keyHandler: null,
      runToken: 0,
      mounted: false,
    }

    /** 上一次真正写进 DOM 的值，保证 paint 幂等。 */
    const painted = { label: null, state: null, title: null, display: null }

    const raf = (fn) => (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(fn)
      : setTimeout(fn, 16))
    const cancelRaf = (id) => {
      if (id === null) return
      try {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
        else clearTimeout(id)
      } catch (error) {
        console.error(TAG, 'cancelRaf failed', error)
      }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function scrollBox() {
      try {
        return document.querySelector(SCROLL_SELECTOR)
      } catch (error) {
        console.error(TAG, 'querySelector failed', error)
        return null
      }
    }

    /** 上次命中的按钮，disabled 轮询期间省掉整棵树的重扫。 */
    let cachedButton = null

    function buttonMatches(b) {
      if (!b) return false
      const text = (b.textContent || '').replace(/\s+/g, '')
      return text !== '' && BTN_TEXT.test(text)
    }

    /** 找「加载更早」按钮；null = 已到底。 */
    function findButton() {
      // 1) 上次那个还挂在树上就直接复用 —— 这个会话 DOM 里有几千个 button，
      //    querySelectorAll 每次都要全扫，是 60 秒里最大的一块开销。
      if (cachedButton !== null && cachedButton.isConnected && buttonMatches(cachedButton)) {
        return cachedButton
      }
      cachedButton = null
      const box = scrollBox()
      if (box === null) return null
      try {
        // 2) 快速路径：「加载更早」永远在消息列表最上面，第一个 button 通常就是它
        const first = box.querySelector('button')
        if (buttonMatches(first)) {
          cachedButton = first
          return first
        }
        // 3) 兜底：完整扫描（顶部有别的按钮、或文案变化时）
        for (const b of box.querySelectorAll('button')) {
          if (buttonMatches(b)) {
            cachedButton = b
            return b
          }
        }
      } catch (error) {
        console.error(TAG, 'findButton failed', error)
      }
      return null
    }

    /** 上报给服务端半边；失败只记 debug，不刷屏也不静默。 */
    function report(extra) {
      try {
        const payload = {
          clicks: state.clicks,
          found: state.found,
          status: state.status,
          running: state.running,
          elapsedMs: state.startedAt ? Date.now() - state.startedAt : 0,
          ...extra,
        }
        fetch(REPORT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch((error) => {
          console.debug(TAG, 'report failed (host route may be absent)', error)
        })
      } catch (error) {
        console.error(TAG, 'report threw', error)
      }
    }

    // ── 渲染层：幂等 + 合并 ────────────────────────────────────────────────

    /** 只算出「想要的样子」，不碰 DOM。 */
    function desiredPaint() {
      const box = scrollBox()
      if (box === null) return { display: 'none', label: '', state: '', title: '' }

      if (state.status === 'running') {
        return {
          display: 'flex',
          label: `⇡ ${state.clicks}…`,
          state: 'running',
          title: '正在加载历史，点一下停止',
        }
      }
      if (state.status === 'done') {
        return {
          display: 'flex',
          label: '✓ 已到最早',
          state: 'done',
          title: `全部加载完成（${state.clicks} 次）`,
        }
      }
      if (state.status === 'timeout') {
        return {
          display: 'flex',
          label: '⇡ 已停止',
          state: 'idle',
          title: `无新进展，已停止（${state.clicks} 次）`,
        }
      }
      if (findButton() === null) {
        return { display: 'flex', label: '✓ 已全载', state: 'done', title: '这个会话已经全部载入' }
      }
      return { display: 'flex', label: '⇡ 全量加载', state: 'idle', title: '一键加载全部历史（Ctrl+Alt+Home）' }
    }

    /**
     * 幂等写入：值没变就不碰 DOM。
     * 这是「observer → paint → observer」循环的第二道闸 —— 即使被调度，
     * 没有实际变化就不会产生新的 mutation。
     */
    function paint() {
      const pill = res.pill
      const label = res.label
      if (pill === null || label === null || res.disposed) return
      try {
        const want = desiredPaint()
        if (want.display !== painted.display) {
          pill.style.display = want.display
          painted.display = want.display
        }
        if (want.label !== painted.label) {
          label.textContent = want.label
          painted.label = want.label
        }
        if (want.state !== painted.state) {
          pill.dataset.state = want.state
          painted.state = want.state
        }
        if (want.title !== painted.title) {
          pill.title = want.title
          painted.title = want.title
        }
      } catch (error) {
        console.error(TAG, 'paint failed', error)
      }
    }

    /** 合并刷新：一帧内多次 mutation 只画一次。 */
    function schedulePaint() {
      if (res.disposed || res.paintRaf !== null) return
      res.paintRaf = raf(() => {
        res.paintRaf = null
        paint()
      })
    }

    // ── 连点逻辑 ──────────────────────────────────────────────────────────

    function resetRun() {
      state.clicks = 0
      state.found = 0
      state.startedAt = 0
      state.endedAt = 0
      state.error = ''
    }

    async function run() {
      if (res.disposed || state.running) return
      const token = ++res.runToken
      resetRun()
      state.running = true
      state.status = 'running'
      state.startedAt = Date.now()
      schedulePaint()
      report({ event: 'start' })

      let stall = 0
      while (!res.disposed && state.running && token === res.runToken) {
        if (state.clicks >= cfg.maxClicks) {
          state.status = 'timeout'
          state.error = 'max-clicks'
          break
        }
        const btn = findButton()
        if (btn === null) {
          state.status = 'done'
          break
        }
        state.found += 1
        if (btn.disabled) {
          stall += 1
          if (stall >= cfg.stallTicks) {
            state.status = 'timeout'
            state.error = 'stalled'
            break
          }
          await sleep(cfg.readyPollMs)
          continue
        }
        stall = 0
        try {
          btn.click()
          state.clicks += 1
        } catch (error) {
          console.error(TAG, 'click failed', error)
          state.error = String((error && error.message) || error)
          state.status = 'timeout'
          break
        }
        if (state.clicks % cfg.reportEvery === 0) report({ event: 'progress' })
        schedulePaint()
        await sleep(cfg.clickGapMs)
      }

      if (res.disposed) return
      state.running = false
      state.endedAt = Date.now()
      if (state.status === 'running') state.status = 'done'

      if (cfg.scrollTopAtEnd && state.status === 'done') {
        const box = scrollBox()
        if (box !== null) {
          try {
            box.scrollTop = 0
          } catch (error) {
            console.error(TAG, 'scrollToTop failed', error)
          }
        }
      }
      schedulePaint()
      report({ event: 'end' })

      setTimeout(() => {
        if (res.disposed || state.running) return
        if (state.status === 'done') {
          state.status = 'idle'
          schedulePaint()
        }
      }, 3000)
    }

    function stop() {
      if (!state.running) return
      state.running = false
      res.runToken += 1
      state.status = 'stopped'
      schedulePaint()
      report({ event: 'stop' })
    }

    function toggle() {
      try {
        if (state.running) stop()
        else void run()
      } catch (error) {
        console.error(TAG, 'toggle failed', error)
      }
    }

    function onKeydown(e) {
      try {
        if (!e.ctrlKey || !e.altKey) return
        if (e.code === 'Home') {
          e.preventDefault()
          e.stopPropagation()
          toggle()
        } else if (e.code === 'End') {
          e.preventDefault()
          e.stopPropagation()
          const box = scrollBox()
          if (box !== null) box.scrollTop = box.scrollHeight
        }
      } catch (error) {
        console.error(TAG, 'keydown handler failed', error)
      }
    }

    // ── 挂载 / 卸载 ───────────────────────────────────────────────────────

    function mount() {
      if (res.disposed || res.mounted) return
      const head = document.head
      const body = document.body
      if (!head || !body) return // 还没就绪，等下轮轮询

      const style = document.createElement('style')
      style.textContent = `
        .dsh-autoload-pill{
          position:fixed;right:18px;bottom:104px;z-index:60;
          display:none;align-items:center;gap:6px;
          padding:6px 12px;border-radius:999px;cursor:pointer;
          font-size:12px;line-height:18px;font-family:inherit;
          color:var(--dsw-alias-label-primary);
          background:var(--dsw-alias-bg-layer-1);
          border:1px solid var(--dsw-alias-border-l1);
          box-shadow:0 4px 14px rgba(0,0,0,.16);
          opacity:.55;transition:opacity .15s ease,border-color .15s ease;
          user-select:none;
        }
        .dsh-autoload-pill:hover{opacity:1;border-color:var(--dsw-alias-brand-primary)}
        .dsh-autoload-pill[data-state=running]{opacity:1;border-color:var(--dsw-alias-brand-primary)}
        .dsh-autoload-pill[data-state=done]{opacity:.8}
      `
      head.appendChild(style)

      const pill = document.createElement('div')
      pill.className = 'dsh-autoload-pill'
      const label = document.createElement('span')
      pill.appendChild(label)
      pill.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        toggle()
      })
      body.appendChild(pill)

      res.style = style
      res.pill = pill
      res.label = label
      res.mounted = true
      paint()
    }

    /** 等 body/head 就绪；apply 不等它，轮询自己跑。 */
    function waitForDom() {
      if (res.disposed) return
      if (document.head && document.body) {
        mount()
        startObserver()
        startHeartbeat()
        return
      }
      let tries = 0
      const tick = () => {
        if (res.disposed) return
        if (document.head && document.body) {
          res.domTimer = null
          mount()
          startObserver()
          startHeartbeat()
          return
        }
        tries += 1
        if (tries >= cfg.domPollTries) {
          console.error(TAG, 'document.body never became ready; giving up after', tries, 'polls')
          res.domTimer = null
          return
        }
        res.domTimer = setTimeout(tick, cfg.domPollMs)
      }
      res.domTimer = setTimeout(tick, cfg.domPollMs)
    }

    /**
     * 页面观察：忽略浮标自身子树内的变更（第三道闸），外部变更合并成一次刷新。
     */
    function startObserver() {
      if (res.disposed || res.observer !== null || !document.body) return
      try {
        const observer = new MutationObserver((mutations) => {
          if (res.disposed) return
          for (const m of mutations) {
            const pill = res.pill
            if (pill !== null && (m.target === pill || pill.contains(m.target))) continue
            schedulePaint()
            return
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
        res.observer = observer
      } catch (error) {
        console.error(TAG, 'observer setup failed', error)
      }
    }

    /** 浮标被别的插件顶掉时补挂回来；不会重建已存在的那一个。 */
    function startHeartbeat() {
      if (res.disposed || res.heartbeat !== null) return
      res.heartbeat = setInterval(() => {
        if (res.disposed) return
        try {
          if (res.pill !== null && !res.pill.isConnected) {
            res.mounted = false
            res.pill = null
            res.label = null
            painted.label = null
            painted.state = null
            painted.title = null
            painted.display = null
            mount()
          }
        } catch (error) {
          console.error(TAG, 'heartbeat failed', error)
        }
      }, cfg.heartbeatMs)
    }

    function dispose() {
      if (res.disposed) return
      res.disposed = true
      res.runToken += 1
      state.running = false

      if (res.domTimer !== null) clearTimeout(res.domTimer)
      if (res.heartbeat !== null) clearInterval(res.heartbeat)
      res.domTimer = null
      res.heartbeat = null

      cancelRaf(res.paintRaf)
      res.paintRaf = null

      try {
        if (res.observer !== null) res.observer.disconnect()
      } catch (error) {
        console.error(TAG, 'observer disconnect failed', error)
      }
      res.observer = null

      try {
        if (res.keyHandler !== null) document.removeEventListener('keydown', res.keyHandler, true)
      } catch (error) {
        console.error(TAG, 'keydown remove failed', error)
      }
      res.keyHandler = null

      try {
        if (res.pill !== null) res.pill.remove()
      } catch (error) {
        console.error(TAG, 'pill remove failed', error)
      }
      try {
        if (res.style !== null) res.style.remove()
      } catch (error) {
        console.error(TAG, 'style remove failed', error)
      }
      res.pill = null
      res.label = null
      res.style = null
      res.mounted = false
    }

    function apply(ctx) {
      try {
        res.keyHandler = onKeydown
        document.addEventListener('keydown', res.keyHandler, true)
        waitForDom() // 立即返回，不阻塞宿主启动
      } catch (error) {
        console.error(TAG, 'apply failed', error)
        dispose()
      }

      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(() => dispose, 'dsh-autoload: dom')
        } catch (error) {
          console.error(TAG, 'ctx.effect registration failed', error)
        }
      }

      setTimeout(() => {
        if (res.disposed) return
        report({ event: 'hello', hasBox: scrollBox() !== null, hasButton: findButton() !== null })
      }, 1500)

      console.log(TAG, 'client ready (v0.2.0)')
    }

    exports.apply = apply
    exports._state = state
    exports._dispose = dispose
    return module.exports
  },
})
