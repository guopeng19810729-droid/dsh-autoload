/**
 * dsh-autoload v0.2.0 离线冒烟测试
 *
 * 用最小 DOM stub 跑一遍 client.js 的 factory + apply，验证：
 *   1. apply 不抛错，且立即返回（不 await DOM）
 *   2. document.body 还没就绪时不崩，就绪后自动挂载
 *   3. 浮标文案按状态正确渲染
 *   4. observer 忽略浮标自身变更；外部变更合并刷新
 *   5. paint 幂等 —— 文案不变时不再写 DOM（循环的根因）
 *   6. dispose 完整清理（元素移除、监听器摘除）
 */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const SRC = 'F:\\AI_WORK\\DSH-NB_WORK\\插件安装维护\\dsh-autoload\\lib\\client.js'
const code = fs.readFileSync(SRC, 'utf8')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + detail}`)
}

// ── 最小 DOM stub ────────────────────────────────────────────────────────────
let textWrites = 0
const created = []

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parent = null
    this.style = {}
    this.dataset = {}
    this.isConnected = false
    this._text = ''
    this._listeners = []
    created.push(this)
  }
  get textContent() { return this._text }
  set textContent(v) {
    if (this._text === v) return
    this._text = v
    textWrites += 1
  }
  appendChild(child) {
    this.children.push(child)
    child.parent = this
    child.isConnected = true
    return child
  }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this)
      this.parent = null
    }
    this.isConnected = false
  }
  contains(node) {
    if (node === this) return true
    return this.children.some((c) => c.contains(node))
  }
  addEventListener(type, fn) { this._listeners.push({ type, fn }) }
  removeEventListener(type, fn) {
    this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn))
  }
  querySelectorAll() { return [] }
}

let observerCallback = null
class MutationObserverStub {
  constructor(cb) { observerCallback = cb }
  observe() { this.observed = true }
  disconnect() { this.disconnected = true; observerCallback = null }
}

const head = new El('head')
const bodyEl = new El('body')
head.isConnected = true

const loadMoreBtn = {
  textContent: '加载更早',
  disabled: false,
  isConnected: true,
  clicks: 0,
  click() { this.clicks += 1 },
}

const sessionBox = new El('div')
sessionBox.querySelector = (sel) => (sel === 'button' && loadMoreBtn.textContent ? loadMoreBtn : null)
sessionBox.querySelectorAll = (sel) => (sel === 'button' && loadMoreBtn.textContent ? [loadMoreBtn] : [])

const docListeners = []
const documentStub = {
  head: null,
  body: null,
  createElement: (tag) => new El(tag),
  querySelector: (sel) => (sel === '[data-conversation-scroll]' ? sessionBox : null),
  addEventListener: (type, fn, cap) => docListeners.push({ type, fn, cap }),
  removeEventListener: (type, fn) => {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) docListeners.splice(i, 1)
  },
}

let capturedEntry = null
const windowStub = {
  __ModuleLoader__: {
    load(entry) { capturedEntry = entry },
  },
}

const fetchCalls = []
const sandbox = {
  window: windowStub,
  document: documentStub,
  MutationObserver: MutationObserverStub,
  fetch: (url, opts) => {
    fetchCalls.push({ url, body: opts && opts.body })
    return Promise.resolve({ ok: true })
  },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console: {
    log: (...a) => { if (String(a[0]).includes('[dsh-autoload]')) console.log('   ·', ...a) },
    error: (...a) => console.log('   !', ...a),
    debug: () => {},
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

async function main() {
  // 1) 执行 bundle
  try {
    vm.runInContext(code, sandbox, { filename: 'client.js' })
    check('bundle 执行无异常', true)
  } catch (error) {
    check('bundle 执行无异常', false, String(error && error.message))
    return finish()
  }

  check('ModuleLoader 收到 entry 且 id 正确', capturedEntry !== null && capturedEntry.id === 'dsh-autoload',
    capturedEntry && capturedEntry.id)

  const mod = capturedEntry.factory()
  check('factory 导出 apply 函数', typeof mod.apply === 'function')

  // 2) body 还没就绪时 apply —— 这是 v0.1.0 崩掉的点
  let applyThrew = null
  let returnedSync = false
  try {
    mod.apply({ effect: () => {} })
    returnedSync = true
  } catch (error) {
    applyThrew = error
  }
  check('body 未就绪时 apply 不抛异常', applyThrew === null, applyThrew && applyThrew.message)
  check('apply 同步立即返回（不 await DOM）', returnedSync)

  // 3) 让 DOM 就绪
  documentStub.head = head
  documentStub.body = bodyEl
  await new Promise((r) => setTimeout(r, 400))

  const pill = bodyEl.children.find((c) => c.className === 'dsh-autoload-pill')
  check('body 就绪后浮标已挂载', pill !== undefined)
  check('样式已注入 <head>', head.children.some((c) => c.tagName === 'STYLE'))
  check('快捷键监听已注册', docListeners.some((l) => l.type === 'keydown'))

  if (pill) {
    const label = pill.children[0]
    check('初始文案为「⇡ 全量加载」', label.textContent === '⇡ 全量加载', label.textContent)
    check('浮标在会话区存在时可见', pill.style.display === 'flex', pill.style.display)
  }

  // 4) observer 忽略浮标自身变更
  const before = textWrites
  if (observerCallback) {
    observerCallback([{ target: pill.children[0] }])
    await new Promise((r) => setTimeout(r, 60))
    check('浮标内部变更被忽略，不触发重绘', textWrites === before, `textWrites ${before} -> ${textWrites}`)
  }

  // 5) paint 幂等：外部连续 20 次变更，文案不变时不应重复写 DOM
  const before2 = textWrites
  for (let i = 0; i < 20; i += 1) {
    if (observerCallback) observerCallback([{ target: sessionBox }])
    await new Promise((r) => setTimeout(r, 12))
  }
  check('外部变更合并刷新且幂等（20 次变更不重复写文案）', textWrites - before2 <= 1,
    `额外写入 ${textWrites - before2} 次`)

  // 6) 按钮消失 → 文案切到「已全载」
  loadMoreBtn.textContent = ''
  if (observerCallback) observerCallback([{ target: sessionBox }])
  await new Promise((r) => setTimeout(r, 80))
  const label2 = pill && pill.children[0]
  check('按钮消失后文案切为「✓ 已全载」', label2 && label2.textContent === '✓ 已全载', label2 && label2.textContent)

  // 7) dispose 清理
  mod._dispose()
  await new Promise((r) => setTimeout(r, 30))
  check('dispose 后浮标已移除', !bodyEl.children.some((c) => c.className === 'dsh-autoload-pill'))
  check('dispose 后样式已移除', !head.children.some((c) => c.tagName === 'STYLE'))
  check('dispose 后快捷键监听已摘除', !docListeners.some((l) => l.type === 'keydown'))

  // 8) dispose 之后不再重挂（心跳/轮询不许复活）
  await new Promise((r) => setTimeout(r, 2500))
  check('dispose 后 2.5 秒内没有复活', !bodyEl.children.some((c) => c.className === 'dsh-autoload-pill'))

  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log('\n──────────────────────────────')
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) failed.forEach((f) => console.log('  FAILED:', f.name, f.detail ?? ''))
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试脚本自身异常:', error)
  process.exit(1)
})
