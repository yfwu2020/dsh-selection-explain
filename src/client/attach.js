/**
 * 小窗附件：选图片 / 文件 → 上传到 host 存成持久附件 → 发送时把引用带进这一轮追问。
 *
 * 三条入口（和主会话一致，也覆盖了"手上已经有东西"的全部常见情形）：
 *   ① 工具行最左的 ＋ → 系统文件选择器（图片与文件一起选，不分成两个键）；
 *   ② ⌘/Ctrl + V：截图之后直接粘（这条最常用，很多人根本不会去点 ＋）；
 *   ③ 把文件拖到小窗任意位置（整窗虚线遮罩，松手即加）。
 *
 * 状态机（每一件独立，互不牵连）：
 *   uploading → done | error，error 可以就地重试。
 *   为什么逐件独立：host 那条路是"一个文件一次请求"，一张图被拒不该把同批里别的附件废掉。
 *
 * 上传中的表现：转圈 + **不定态**进度条。fetch 没有上传进度事件，
 * 假装知道百分比比不给进度更糟（主会话在首次报告字节之前用的也是不定态）。
 */
import { el, listen } from './dom.js'
import { ATTACH, ATTACHMENT, ATTACH_MAX_ITEMS, ATTACH_MAX_ITEM_BYTES } from './constants.js'
import { docIcon, imageIcon, spinnerIcon, retryIcon } from './icons.js'

/**
 * 附件引用的 base64url 编码（放进 `?ref=`）。
 *
 * 走 TextEncoder + btoa 而不是裸 btoa：引用的 `name` 可能是中文（"季度报表.pdf"），
 * 裸 btoa 遇到非 Latin-1 字符会直接抛异常。
 */
export function encodeAttachmentRef(ref) {
  var json = JSON.stringify(ref || {})
  if (typeof TextEncoder === 'function') {
    var bytes = new TextEncoder().encode(json)
    var binary = ''
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
    json = binary
  }
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 取回这个附件字节的地址（图片给 <img>，文件给下载链接）。 */
export function attachmentUrl(kind, ref, download) {
  return ATTACHMENT + '?kind=' + (kind === 'file' ? 'file' : 'image') + '&ref=' + encodeAttachmentRef(ref) + (download ? '&download=1' : '')
}

/** 字节数 → 人话（文件卡第二行用）。 */
export function formatBytes(bytes) {
  var value = typeof bytes === 'number' && isFinite(bytes) ? bytes : 0
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / 1024 / 1024).toFixed(1) + ' MB'
}

/** 取扩展名（大写）。没有就返回 FILE —— 卡片上那行小字宁可写 FILE 也不留空。 */
export function extensionOf(name) {
  var match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return match ? match[1].toUpperCase() : 'FILE'
}

/**
 * File → canonical base64（不带 `data:` 前缀）。
 *
 * 走 FileReader 的 dataURL 而不是手写 btoa 分块：几 MB 的文件用 btoa 拼字符串会卡主线程，
 * 而 readAsDataURL 是浏览器自己实现的分块读取。
 */
export function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader()
    reader.onload = function () {
      var result = String(reader.result || '')
      var comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = function () {
      reject(reader.error || new Error('读取文件失败'))
    }
    reader.readAsDataURL(file)
  })
}

/** 这个 File 看起来像文件夹（拖进来的目录：0 字节、没有类型、也没有扩展名）。 */
export function looksLikeDirectory(file) {
  return file && file.size === 0 && !file.type && !/\.[A-Za-z0-9]+$/.test(String(file.name || ''))
}

export function createAttachController(env) {
  var seq = 0

  /** 当前这一条追问带的附件（挂在 state 上：历史回放 / 升格都要能看到它）。 */
  function items() {
    return env.state.attachments
  }

  function note(text) {
    env.state.attachNote = text || ''
    renderNote()
  }

  function renderNote() {
    if (!env.attachNote) return
    env.attachNote.textContent = env.state.attachNote || ''
    env.attachNote.setAttribute('data-show', env.state.attachNote ? '1' : '0')
  }

  /** 还有没有在传的（发送键据此置灰）。 */
  function busy() {
    var list = items()
    for (var i = 0; i < list.length; i += 1) if (list[i].status === 'uploading') return true
    return false
  }

  /** 发送时给 host 的那份：[{ kind, ref }]，只算传成功的。 */
  function payload() {
    var out = []
    var list = items()
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].status === 'done' && list[i].ref) out.push({ kind: list[i].kind, ref: list[i].ref })
    }
    return out
  }

  /**
   * 拼进**这一条消息**的附件说明。
   *
   * 为什么要拼：小窗的对话历史只存文本（history-store），模型在后续轮次里看不到上一轮那张图。
   * 带上这行，至少"上一轮带过哪些材料"在历史里是连续的；文件那边另有 dsh-llm 自动注入的只读路径，
   * 模型随时能按路径把内容读回来。
   */
  function describe(explicit) {
    // 可以传一份显式列表：sendAsk 里附件**已经从 composer 收走了**，
    // 这时再读 state 只会读到空数组，拼出来的说明就是空的。
    var list = explicit || items()
    var names = []
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].status !== 'done' || !list[i].ref) continue
      names.push(list[i].name + (list[i].kind === 'image' ? '（图片）' : '（文件）'))
    }
    if (names.length === 0) return ''
    return '【本条消息带了附件】' + names.join('、')
  }

  function clear() {
    var list = items()
    for (var i = 0; i < list.length; i += 1) revoke(list[i])
    env.state.attachments = []
    env.state.attachNote = ''
    render()
  }

  function revoke(item) {
    if (item && item.url && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      try {
        URL.revokeObjectURL(item.url)
      } catch (error) {
        /* 桩环境 / 老浏览器：拿不到就别管，泄漏一个 object URL 不影响功能 */
      }
    }
  }

  function remove(id) {
    var list = items()
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) {
        revoke(list[i])
        list.splice(i, 1)
        break
      }
    }
    env.state.attachNote = ''
    render()
    env.refreshAskState()
  }

  /** 把一批 File 加进来（选择器 / 粘贴 / 拖放共用这一条）。 */
  function addFiles(files) {
    var list = items()
    var incoming = []
    for (var i = 0; i < files.length; i += 1) incoming.push(files[i])
    if (incoming.length === 0) return
    var rejected = []
    for (var j = 0; j < incoming.length; j += 1) {
      var file = incoming[j]
      if (looksLikeDirectory(file)) {
        rejected.push('「' + (file.name || '未命名') + '」是文件夹，不支持')
        continue
      }
      if (list.length >= ATTACH_MAX_ITEMS) {
        rejected.push('一次最多带 ' + ATTACH_MAX_ITEMS + ' 件附件')
        break
      }
      if (file.size > ATTACH_MAX_ITEM_BYTES) {
        rejected.push('「' + file.name + '」超过单件上限 ' + formatBytes(ATTACH_MAX_ITEM_BYTES))
        continue
      }
      list.push(createItem(file))
    }
    note(rejected.join('；'))
    render()
    env.refreshAskState()
    // 串行上传：并发几 MB 的 base64 会把主线程和 host 的 sharp 一起顶住
    var pending = list.filter(function (item) {
      return item.status === 'uploading' && !item.started
    })
    var chain = Promise.resolve()
    pending.forEach(function (item) {
      chain = chain.then(function () {
        return upload(item)
      })
    })
  }

  function createItem(file) {
    var isImage = /^image\//.test(String(file.type || ''))
    var item = {
      id: ++seq,
      kind: isImage ? 'image' : 'file',
      name: file.name || (isImage ? '粘贴的图片' : '未命名文件'),
      size: typeof file.size === 'number' ? file.size : 0,
      mediaType: file.type || 'application/octet-stream',
      file: file,
      // 缩略图先用本地 object URL 显示（不必等上传完），失败时回落到图标
      url: isImage && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : '',
      status: 'uploading',
      started: false,
      ref: null,
      error: '',
    }
    return item
  }

  function upload(item) {
    if (item.started) return Promise.resolve()
    item.started = true
    item.status = 'uploading'
    item.error = ''
    render()
    return fileToBase64(item.file)
      .then(function (data) {
        return fetch(ATTACH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [{ kind: item.kind, name: item.name, mediaType: item.mediaType, data: data }],
          }),
        })
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {}
          })
          .then(function (body) {
            if (!response.ok || !body || body.ok !== true) {
              throw new Error((body && body.error) || 'HTTP ' + response.status)
            }
            var first = body.items && body.items[0]
            if (!first || !first.ref) throw new Error('上传后没有拿到附件引用')
            item.ref = first.ref
            item.status = 'done'
            item.file = null
            // 服务端会规范化图片（可能被重编码/缩小），名字与字节数以引用为准
            if (first.ref.name) item.name = String(first.ref.name)
            if (typeof first.ref.bytes === 'number') item.size = first.ref.bytes
            // 这一件好了：若那行提示说的正是它，就撤掉（别留着一条已经过期的报错）
            if (env.state.attachNote.indexOf(item.name) >= 0) note('')
          })
      })
      .catch(function (error) {
        item.status = 'error'
        item.error = String((error && error.message) || error)
        // 失败原因要**写出来**：只把缩略图标红，用户不知道是被拒了还是网络断了、
        // 更不知道该换一张图还是该重试。host 那边已经翻成人话了，这里原样带出去。
        note('「' + item.name + '」' + item.error)
      })
      .then(function () {
        render()
        env.refreshAskState()
      })
  }

  function retry(id) {
    var list = items()
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id && list[i].status === 'error') {
        if (!list[i].file) {
          note('这一件已经没法重试了，请重新添加')
          return
        }
        list[i].started = false
        upload(list[i])
        return
      }
    }
  }

  // ────────────────────────────── 渲染 ──────────────────────────────

  function render() {
    var box = env.attachBox
    if (!box) return
    var list = items()
    box.textContent = ''
    box.setAttribute('data-show', list.length > 0 ? '1' : '0')
    for (var i = 0; i < list.length; i += 1) {
      box.appendChild(list[i].kind === 'image' ? thumbNode(list[i]) : fileNode(list[i]))
    }
    renderNote()
  }

  function removeButton(item) {
    var button = el('button', 'dsh-sel-attachx', '✕')
    button.type = 'button'
    button.title = '移除「' + item.name + '」'
    button.setAttribute('aria-label', '移除附件 ' + item.name)
    listen(button, 'click', function (event) {
      event.stopPropagation()
      remove(item.id)
    })
    return button
  }

  function thumbNode(item) {
    var node = el('span', 'dsh-sel-thumb')
    node.setAttribute('data-state', item.status)
    node.title = item.name
    if (item.url) {
      var img = document.createElement('img')
      img.src = item.url
      img.alt = item.name
      node.appendChild(img)
    } else {
      node.appendChild(imageIcon())
    }
    if (item.status === 'uploading') {
      var spin = el('span', 'dsh-sel-attachspin')
      spin.appendChild(spinnerIcon())
      node.appendChild(spin)
      var bar = el('span', 'dsh-sel-attachbar')
      bar.appendChild(el('i'))
      node.appendChild(bar)
    } else if (item.status === 'error') {
      var retryBox = el('span', 'dsh-sel-attachspin')
      retryBox.style.background = 'transparent'
      retryBox.title = '上传失败，点击重试'
      var retryButton = el('button', 'dsh-sel-attachx', '')
      retryButton.type = 'button'
      retryButton.style.position = 'static'
      retryButton.style.width = '20px'
      retryButton.style.height = '20px'
      retryButton.setAttribute('aria-label', '重试上传 ' + item.name)
      retryButton.appendChild(retryIcon())
      listen(retryButton, 'click', function (event) {
        event.stopPropagation()
        retry(item.id)
      })
      retryBox.appendChild(retryButton)
      node.appendChild(retryBox)
    }
    node.appendChild(removeButton(item))
    return node
  }

  function fileNode(item) {
    var node = el('span', 'dsh-sel-fcard')
    node.setAttribute('data-state', item.status)
    var icon = el('span', 'dsh-sel-fico')
    icon.appendChild(docIcon())
    node.appendChild(icon)
    node.appendChild(el('span', 'dsh-sel-fname', item.name))
    var meta = extensionOf(item.name) + ' · ' + formatBytes(item.size)
    if (item.status === 'uploading') meta = '正在上传…'
    node.appendChild(el('span', 'dsh-sel-fmeta', meta))
    if (item.status === 'error') {
      var retryButton = el('button', 'dsh-sel-fretry', '重试')
      retryButton.type = 'button'
      listen(retryButton, 'click', function (event) {
        event.stopPropagation()
        retry(item.id)
      })
      node.appendChild(retryButton)
    }
    node.appendChild(removeButton(item))
    return node
  }

  // ────────────────────────────── 入口 ──────────────────────────────

  /** ＋：开系统文件选择器。图片和文件一起选 —— 不分成两个键（选择器自己会过滤）。 */
  function pick() {
    if (!env.attachInput) return
    env.attachInput.value = ''
    env.attachInput.click()
  }

  /** ⌘/Ctrl + V：剪贴板里是文件/截图才算数，纯文本照旧进输入框。 */
  function handlePaste(event) {
    var files = event.clipboardData && event.clipboardData.files
    if (!files || files.length === 0) return
    event.preventDefault()
    addFiles(files)
    env.setStatus('已从剪贴板添加 ' + files.length + ' 件附件')
  }

  /**
   * 这次拖拽带的是不是**文件**。
   *
   * 只有文件才由小窗接管。拖一段文字进来（主会话的 composer 支持）时小窗**完全不插手**，
   * 让它照常落进主会话 —— 小窗没有"接文字"这回事，抢下来只会让用户莫名其妙。
   */
  function isFileDrag(event) {
    var transfer = event.dataTransfer
    if (!transfer) return false
    var types = transfer.types
    if (!types) return false
    for (var i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true
    }
    return false
  }

  /**
   * 拖放：整个面板都是投放区（拖到正文上也算），拖进来时铺一层虚线遮罩。
   *
   * ⚠️ **必须掐断冒泡**，否则文件会同时落进主会话的输入框。
   * 主会话的投放监听是 `document.addEventListener('drop', …)`（冒泡阶段、无 capture），
   * 而它**不检查 `defaultPrevented`** —— 只 `preventDefault()` 拦不住它，
   * 事件照样冒到 document，那边再 `onAddFiles` 一次，于是一份文件进了两个输入框。
   * 面板比 document 深，冒泡时先到我们这儿，`stopPropagation()` 就能把它截在小窗里。
   *
   * dragenter/dragleave 会在子元素之间反复触发，所以用**计数**而不是布尔：
   * 布尔会被"从正文移到输入框"这种内部移动瞬间清掉，遮罩一闪一闪。
   */
  function wireDrop() {
    var depth = 0
    var panel = env.panel
    if (!panel) return
    function show() {
      panel.setAttribute('data-dropping', '1')
    }
    function hide() {
      depth = 0
      panel.removeAttribute('data-dropping')
    }
    listen(panel, 'dragenter', function (event) {
      if (!isFileDrag(event)) return
      // 拦在这里：主会话的"全视口拖放遮罩"也不该在小窗上方点亮
      event.preventDefault()
      event.stopPropagation()
      depth += 1
      show()
    })
    listen(panel, 'dragover', function (event) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer.dropEffect !== undefined) event.dataTransfer.dropEffect = 'copy'
    })
    listen(panel, 'dragleave', function (event) {
      if (!isFileDrag(event)) return
      event.stopPropagation()
      depth -= 1
      if (depth <= 0) hide()
    })
    listen(panel, 'drop', function (event) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      hide()
      var files = event.dataTransfer.files
      if (files && files.length > 0) {
        addFiles(files)
        env.setStatus('已添加 ' + files.length + ' 件附件')
      }
    })
  }

  return {
    items,
    addFiles,
    remove,
    clear,
    retry,
    render,
    busy,
    payload,
    describe,
    note,
    pick,
    handlePaste,
    wireDrop,
  }
}
