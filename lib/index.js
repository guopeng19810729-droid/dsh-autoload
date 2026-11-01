/**
 * dsh-autoload — 服务端（Host 半边）v0.2.1
 *
 * 只做一件事：给客户端那一半一个回传口，方便从外部验证插件真的在页面里
 * 跑起来了、真的点到了按钮，并留下最近几次运行的记录供复盘。
 * 所有实际动作都在客户端完成（纯 DOM）。
 *
 * 路由：
 *   POST /dsh-autoload/report   客户端上报运行统计
 *   GET  /dsh-autoload/status   进程信息 + 最近 5 次运行记录
 *   GET  /dsh-autoload/ping     存活探测
 *
 * v0.2.1 改动：/status 保留最近 5 次「运行」（一次 start→end/stop 算一次），
 * 不再只留最后一条 —— 之前刚跑完 81 次的那条会被紧接着的第二次点击覆盖。
 */

export const name = 'dsh-autoload'
export const inject = ['webServer']

const ROUTE = '/dsh-autoload'
const MAX_RUNS = 5

export function apply(ctx) {
  const state = {
    bootAt: Date.now(),
    reports: 0,
    lastReport: null,
    current: null,   // 进行中的一次运行
    runs: [],        // 已定稿的运行，最新的在前，最多 MAX_RUNS 条
    hello: null,     // 最近一次客户端握手
  }

  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer) {
    console.log('[dsh-autoload] 无 webServer 服务，服务端半边跳过')
    return
  }

  /** 把一次运行收进历史。 */
  function settle(run, reason) {
    if (run === null) return
    const finishedAt = Date.now()
    const entry = {
      startedAt: run.startedAt,
      finishedAt,
      durationMs: finishedAt - run.startedAt,
      clicks: run.clicks,
      found: run.found,
      status: run.status,
      reason,
      error: run.error || '',
    }
    state.runs.unshift(entry)
    if (state.runs.length > MAX_RUNS) state.runs.length = MAX_RUNS
  }

  function absorb(payload) {
    const event = String(payload.event || '')
    const now = Date.now()

    if (event === 'hello') {
      state.hello = { ...payload, at: now }
      return { handled: 'hello' }
    }

    if (event === 'start') {
      // 上一次还没收尾就来了新的一轮：按 interrupted 记下，避免丢记录
      if (state.current !== null) settle(state.current, 'interrupted')
      state.current = {
        startedAt: now,
        clicks: Number(payload.clicks) || 0,
        found: Number(payload.found) || 0,
        status: 'running',
        error: '',
      }
      return { handled: 'start' }
    }

    // progress / stop / end 都更新进行中的那次
    if (state.current !== null) {
      if (typeof payload.clicks === 'number') state.current.clicks = payload.clicks
      if (typeof payload.found === 'number') state.current.found = payload.found
      if (typeof payload.status === 'string') state.current.status = payload.status
      if (typeof payload.error === 'string' && payload.error !== '') state.current.error = payload.error
    }

    if (event === 'stop' || event === 'end') {
      settle(state.current, event)
      state.current = null
    }

    return { handled: event || 'unknown' }
  }

  // 路由挂到 ctx.effect：插件被关开关/热重载时宿主会跑 disposer 摘路由，
  // 否则同一进程里再次 apply 会撞 duplicate route。
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler(req, res) {
        const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
        const tail = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : url.pathname

        const send = (code, obj) => {
          const body = JSON.stringify(obj, null, 2)
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        }

        if (tail === '/ping') {
          send(200, { ok: true, plugin: name, uptimeMs: Date.now() - state.bootAt })
          return
        }

        if (tail === '/status') {
          send(200, {
            ok: true,
            plugin: name,
            uptimeMs: Date.now() - state.bootAt,
            reports: state.reports,
            current: state.current,
            runs: state.runs,
            hello: state.hello,
            lastReport: state.lastReport,
          })
          return
        }

        if (tail === '/report' && req.method === 'POST') {
          const chunks = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              state.reports += 1
              state.lastReport = { ...payload, at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 80) }
              const result = absorb(payload)
              send(200, { ok: true, accepted: true, reports: state.reports, ...result })
            } catch (error) {
              send(400, { ok: false, error: String(error && error.message) })
            }
          })
          return
        }

        send(404, { ok: false, error: 'not found' })
      },
    }),
  )
}
