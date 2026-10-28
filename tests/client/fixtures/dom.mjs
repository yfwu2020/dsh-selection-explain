/** Minimal DOM and event model shared by isolated client scenarios. */
export function createDomFixture() {
  function textOf(node) {
    if (!node) return ''
    let out = node._text || ''
    for (const child of node.children || []) out += textOf(child)
    return out
  }


  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      // 真实 DOM 里元素是 1、文本是 3：插件里有 target.nodeType 之类的判断，桩要跟上
      this.nodeType = String(tag) === '#text' ? 3 : 1
      this.children = []
      // style 用**带 display setter** 的对象：真实浏览器里元素被 display:none 之后会失焦
      // （activeElement 回到 body）。桩原来是个裸对象，不模拟这件事 —— 于是"卡片收起后
      // 焦点还挂在它隐藏的 textarea 上"，让后面的"别处正在打字就不抢焦点"守卫误判
      // （实测：自动聚焦规则一直不生效，查了半天才发现是桩不忠实）。
      var displayValue = ''
      this.style = {}
      Object.defineProperty(this.style, 'display', {
        get: function () {
          return displayValue
        },
        set: function (value) {
          displayValue = value
          if (value === 'none' && documentStub && documentStub.activeElement === this) {
            documentStub.activeElement = body
          }
        },
        enumerable: true,
        configurable: true,
      })
      this.dataset = {}
      this.attrs = {}
      this._text = ''
      this.parentNode = null
      this.className = ''
      this.offsetWidth = 0
      this.offsetHeight = 0
      this.scrollTop = 0
      this.scrollHeight = 0
      this.clientHeight = 0
      this._listeners = new Map()
      // 输入框语义：textarea/input 的 value 与选区。真实 DOM 里给 value 赋值会把光标
      // 挪到末尾、setSelectionRange 能定位 —— 语音输入要验"插在光标处"，桩必须跟着做到。
      this._value = ''
      this.selectionStart = 0
      this.selectionEnd = 0
    }
    get value() {
      return this._value
    }
    set value(next) {
      this._value = next === undefined || next === null ? '' : String(next)
      this.selectionStart = this._value.length
      this.selectionEnd = this._value.length
    }
    setSelectionRange(start, end) {
      this.selectionStart = start
      this.selectionEnd = end === undefined ? start : end
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.push(child)
      return child
    }
    insertBefore(child, reference) {
      if (reference == null) return this.appendChild(child)
      if (child === reference) return child
      if (!this.children.includes(reference)) throw new Error('Reference node is not a child')
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.splice(this.children.indexOf(reference), 0, child)
      return child
    }
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      child.parentNode = null
      return child
    }
    contains(node) {
      let cur = node
      while (cur) {
        if (cur === this) return true
        cur = cur.parentNode
      }
      return false
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value)
    }
    removeAttribute(key) {
      delete this.attrs[key]
    }
    hasAttribute(key) {
      return this.getAttribute(key) !== null
    }
    getAttribute(key) {
      return this.attrs[key] ?? null
    }
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(handler)
    }
    removeEventListener(type, handler) {
      const list = this._listeners.get(type) || []
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    }
    dispatch(type, event) {
      for (const handler of this._listeners.get(type) || []) handler(event)
    }
    getBoundingClientRect() {
      // 临时卡片：给一个**和选区自洽**的矩形（落在选区下方）。
      // 用通用矩形（top:100）的话卡片会跑到选区上方，牵引线走"卡片在上方"那条分支，
      // 断言就量不到真实场景（卡片在下方）——这个坑我踩过一次。
      if (this.className === 'dsh-sel-vcard') {
        return { left: 940, top: 222, right: 1300, bottom: 264, width: 360, height: 42 }
      }
      return { left: 40, top: 100, right: 500, bottom: 400, width: 460, height: 300 }
    }
    /**
     * 真实 DOM：display:none 的元素没有盒子（空列表）——**祖先隐藏也算**。
     * 插件判断"这个输入框是不是还在页面上"靠它（临时语音卡收起时隐藏的是卡片，不是里面的输入框）。
     * ⚠️ 合并进原来那个固定矩形版本：类方法同名会**后者覆盖前者**，留两个的话新写的会被悄悄盖掉（踩过）。
     */
    getClientRects() {
      var node = this
      while (node) {
        if (node.style && node.style.display === 'none') return []
        node = node.parentNode
      }
      return [{ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }]
    }
    get firstChild() {
      // 真实 DOM 的 firstChild：插件用 while (node.firstChild) 清空子节点，桩必须有
      return this.children.length ? this.children[0] : null
    }
    get textContent() {
      return textOf(this)
    }
    set textContent(value) {
      this.children = []
      this._text = value === undefined || value === null ? '' : String(value)
    }
    get innerText() {
      return textOf(this)
    }
    querySelector(selector) {
      // 只认 .class 选择器（够 placePill 量费用胶囊用）；真实 DOM 的行为由浏览器实测覆盖
      const want = typeof selector === 'string' && selector.startsWith('.') ? selector.slice(1) : null
      if (!want) return null
      for (const node of walk(this)) {
        if (String(node.className || '').split(/\s+/).includes(want)) return node
      }
      return null
    }
    focus() {}
    select() {}
  }


  const head = new FakeEl('head')

  const body = new FakeEl('body')

  const documentStub = {
    head,
    body,
    title: 'stub-doc',
    _listeners: new Map(),
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
    createTextNode: (text) => {
      const node = new FakeEl('#text')
      node._text = String(text)
      return node
    },
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(handler)
    },
    removeEventListener(type, handler) {
      const list = this._listeners.get(type) || []
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    },
    dispatch(type, event) {
      for (const handler of [...(this._listeners.get(type) || [])]) handler(event)
    },
    // 默认没有费用胶囊；测试里挂上假的（globalThis.__fakeSpendWidget）后就能被量到。
    // 真实 DOM 是 id="dsh-spend-widget"（无 class）> .dsu-widget > .dsu-pill，这里两种都认。
    querySelector: (selector) =>
      selector === '.dsu-widget' || selector === '.dsh-spend-widget' ? globalThis.__fakeSpendWidget || null : null,
    getElementById: (id) => (id === 'dsh-spend-widget' ? globalThis.__fakeSpendWidget || null : null),
    createRange() {
      return {
        _node: null,
        _end: null,
        selectNodeContents(node) {
          this._node = node
        },
        setEnd(node, offset) {
          this._end = { node, offset }
        },
        cloneRange() {
          const clone = { ...this, cloneRange: this.cloneRange }
          return Object.assign(Object.create(Object.getPrototypeOf(this)), this)
        },
        toString() {
          const full = textOf(this._node)
          return this._end ? full.slice(0, this._end.offset) : full
        },
        getClientRects: () => [{ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }],
        getBoundingClientRect: () => ({ left: 40, top: 100, right: 200, bottom: 118, width: 160, height: 18 }),
      }
    },
  }


  /** ResizeObserver 桩：只记录回调，测试里手动 fire（触发时机由浏览器决定，逻辑在这里验）。 */
  const resizeObservers = []

  class ResizeObserverStub {
    constructor(cb) {
      this.cb = cb
      resizeObservers.push(this)
    }
    observe() {}
    disconnect() {
      this.disconnected = true
    }
    fire() {
      if (!this.disconnected) this.cb([])
    }
  }


  const windowStub = {
    innerWidth: 1440,
    innerHeight: 900,
    _listeners: new Map(),
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(handler)
    },
    removeEventListener(type, handler) {
      const list = this._listeners.get(type) || []
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    },
    dispatch(type, event) {
      for (const handler of [...(this._listeners.get(type) || [])]) handler(event)
    },
    localStorage: {
      _map: new Map(),
      getItem(key) {
        return this._map.has(key) ? this._map.get(key) : null
      },
      setItem(key, value) {
        this._map.set(key, String(value))
      },
    },
    getSelection: () => null,
    __ModuleLoader__: { load: (spec) => { globalThis.__captured = spec } },
  }


  // bundle 通过 new Function 注入这些全局（Node 24 的 navigator 是只读 getter，不能挂 globalThis）
  const navigatorStub = {}


function* walk(node) {
    for (const child of node.children || []) {
      yield child
      yield* walk(child)
    }
  }
  return { ResizeObserverStub, windowStub, documentStub, navigatorStub, FakeEl, body, textOf, resizeObservers, walk }
}
