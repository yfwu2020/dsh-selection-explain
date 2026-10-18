import { el } from './dom.js'

/** 头部小节容器（卡片式；序号 + 标题 + 右侧提示位）。 */
export function buildSection(index, title, key) {
  var root = el('div', 'dsh-sel-sec')
  root.setAttribute('data-sec', key)
  var header = el('div', 'dsh-sel-sh')
  header.appendChild(el('i'))
  var titleNode = el('span', null, title)
  header.appendChild(titleNode)
  var hint = el('span', 'dsh-sel-hint', '')
  header.appendChild(hint)
  var content = el('div', 'dsh-sel-c')
  root.appendChild(header)
  root.appendChild(content)
  return { root: root, content: content, hint: hint, title: titleNode }
}

/**
 * 统一的小图标画布：头部 / 工具行所有图标都从这里出。
 *
 * 规范（与既有 drawXxxIcon 一族逐条对齐，别在调用点另起一套）：
 *   viewBox 0 0 16 16 · 渲染 14px · fill:none · stroke:currentColor
 *   · stroke-width 1.5 · linecap/linejoin round
 * 这样一排图标才有同一套笔画粗细与圆角；混用 Unicode 字形（🕘 ↗ ✕ 🎤）
 * 会因字体不同而粗细、基线、视觉重量全不一样 —— 摆一排就是"割裂"。
 */
export function iconCanvas(size) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'dsh-sel-ic')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size || 14))
  svg.setAttribute('height', String(size || 14))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  return svg
}

export function iconPath(svg, d) {
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  return path
}

/** 关闭（✕）：两条斜线，照既有的 closeIcon 路径。 */
export function headerCloseIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6')
  return svg
}

/** 设置：两轨两把手滑杆。
 *
 *  为什么不是齿轮：多齿版在 14px 下齿牙糊成一团，少齿版**直接渲染成空白**（实测对照过）。
 *  为什么只有两条轨：三条轨三个把手在 14px 下把手会连成一片。
 *  把手画成实心：缩小后对比度更高，仍然认得出"这是滑杆"。 */
export function headerSettingsIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M2.6 5.2h10.8M2.6 10.8h10.8')
  var dots = [[6.2, 5.2], [10.4, 10.8]]
  for (var i = 0; i < dots.length; i += 1) {
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('cx', String(dots[i][0]))
    dot.setAttribute('cy', String(dots[i][1]))
    dot.setAttribute('r', '1.7')
    // 实心把手：fill 跟 currentColor，同时取消描边（否则 1.5 描边会把它胀大一圈）
    dot.setAttribute('fill', 'currentColor')
    dot.setAttribute('stroke', 'none')
    svg.appendChild(dot)
  }
  return svg
}

/** 最近（时钟）：表盘 + 时针分针。外圈 6.1 让墨迹在 16 画布里有 1.9 的呼吸。 */
export function headerHistoryIcon() {
  var svg = iconCanvas(14)
  var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '8')
  circle.setAttribute('cy', '8')
  circle.setAttribute('r', '6.1')
  svg.appendChild(circle)
  iconPath(svg, 'M8 4.6V8l2.4 1.5')
  return svg
}

/** 升格：右下角缺口的方框 + 甩向右上的箭头。 */
export function headerPromoteIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M13.2 9.6v2.4a1.8 1.8 0 0 1-1.8 1.8H4a1.8 1.8 0 0 1-1.8-1.8V4.6A1.8 1.8 0 0 1 4 2.8h2.4')
  iconPath(svg, 'M9.4 2.8h3.8v3.8')
  iconPath(svg, 'M13.2 2.8 8.2 7.8')
  return svg
}

/**
 * 带文字的头部动作键（最近 / 升格 / 设置）。
 *
 * 三个键长得一样很重要：以前混着"文字 key（🕘 最近 / ↗ 升格）"和"纯图标 key（✕）"，
 * 图标又都是 Unicode 字形，粗细与基线各不相同，一排看着像拼起来的。
 * 现在统一成"同一套 SVG 图标 + 同一套边框"，只是有字没字的区别。
 */
export function actionButton(title, label, buildIcon) {
  var node = el('button', 'dsh-sel-action')
  node.type = 'button'
  node.title = title
  if (typeof buildIcon === 'function') node.appendChild(buildIcon())
  node.appendChild(el('span', null, label))
  return node
}

/** 返回（‹）：设置页头部左上的折角。 */
export function backIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M9.8 3.4 5.2 8l4.6 4.6')
  return svg
}

/** 面板头部的小图标按钮。glyph 传图标构造函数（不再是 Unicode 字形）。 */
export function iconButton(title, buildIcon) {
  var node = el('button', 'dsh-sel-icon')
  node.type = 'button'
  node.title = title
  if (typeof buildIcon === 'function') node.appendChild(buildIcon())
  else if (buildIcon) node.textContent = buildIcon
  return node
}

/** 浮标上的星形图标。 */
/** 页面图标（网页模式）。 */
export function pageIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var outer = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  outer.setAttribute('x', '2.4')
  outer.setAttribute('y', '2.4')
  outer.setAttribute('width', '11.2')
  outer.setAttribute('height', '11.2')
  outer.setAttribute('rx', '2.2')
  svg.appendChild(outer)
  var lines = [
    ['M5', '6.2', 'H11'],
    ['M5', '8.6', 'H11'],
    ['M5', '11', 'H8.6'],
  ]
  for (var i = 0; i < lines.length; i += 1) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', lines[i].join(' '))
    svg.appendChild(path)
  }
  return svg
}

/** Markdown 图标（M↓）。滑块里只有 11px，所以描边加粗到 2.6 才认得出。 */
export function markdownIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var peak = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  peak.setAttribute('d', 'M3.5 17.5V7.5l4.4 5 4.4-5v10')
  svg.appendChild(peak)
  var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  arrow.setAttribute('d', 'M17.4 7v9.6M14.3 13.6l3.1 3.1 3.1-3.1')
  svg.appendChild(arrow)
  return svg
}

/** 网页窗口图标（滑块右档）。 */
export function windowIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  frame.setAttribute('x', '3')
  frame.setAttribute('y', '4.5')
  frame.setAttribute('width', '18')
  frame.setAttribute('height', '15')
  frame.setAttribute('rx', '3')
  svg.appendChild(frame)
  var bar = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  bar.setAttribute('d', 'M3 9.6h18')
  svg.appendChild(bar)
  return svg
}

/** 地球图标（留作复用；当前控件已改为窗口图标）。 */
export function globeIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('aria-hidden', 'true')
  var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '8')
  circle.setAttribute('cy', '8')
  circle.setAttribute('r', '5.6')
  svg.appendChild(circle)
  // 经线 + 纬线：一眼看出是"地球/网页"
  var meridian = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  meridian.setAttribute('d', 'M8 2.4c1.9 1.7 2.9 3.6 2.9 5.6S9.9 11.9 8 13.6C6.1 11.9 5.1 10 5.1 8S6.1 4.1 8 2.4z')
  svg.appendChild(meridian)
  var equator = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  equator.setAttribute('d', 'M2.5 8h11')
  svg.appendChild(equator)
  return svg
}

/** 停止图标（圆角方块）：生成中发送键变成它。 */
export function stopIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', '4.4')
  rect.setAttribute('y', '4.4')
  rect.setAttribute('width', '7.2')
  rect.setAttribute('height', '7.2')
  rect.setAttribute('rx', '1.8')
  svg.appendChild(rect)
  return svg
}

/** 取消图标（✕）：两条斜线，和主会话录音行的取消键同形。 */
export function closeIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6')
  svg.appendChild(path)
  return svg
}

/**
 * 麦克风图标：话筒头（圆角矩形）+ 底座弧 + 支架。
 * 用描边而不是实心：录音时这个位置要换成"红色实心停止键"，
 * 平时轻一点，红起来的那一刻对比才够强。
 */
export function micIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var cap = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  cap.setAttribute('d', 'M8 1.9a2.1 2.1 0 0 1 2.1 2.1v3.4a2.1 2.1 0 0 1-4.2 0V4A2.1 2.1 0 0 1 8 1.9z')
  svg.appendChild(cap)
  var arc = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  arc.setAttribute('d', 'M3.6 7.2v.5a4.4 4.4 0 0 0 8.8 0v-.5')
  svg.appendChild(arc)
  var stem = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  stem.setAttribute('d', 'M8 12.1v2')
  svg.appendChild(stem)
  return svg
}

/** 转圈图标（权限请求中 / 识别中）：CSS 让它转起来。 */
export function spinnerIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var arc = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  // 缺一个口的圆：转起来才看得出在动
  arc.setAttribute('d', 'M8 1.8a6.2 6.2 0 1 1-4.4 1.8')
  svg.appendChild(arc)
  return svg
}

/** 发送图标（上箭头，和主会话 composer 一致）。 */
export function sendIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  var shaft = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  shaft.setAttribute('d', 'M8 13.2V3.4')
  svg.appendChild(shaft)
  var head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  head.setAttribute('d', 'M3.9 7.5 8 3.4l4.1 4.1')
  svg.appendChild(head)
  return svg
}

/**
 * 解读浮标上的四角星（✦）。
 *
 * 路径必须在 16×16 画布里**墨迹居中**（上下各留 2.4，墨迹中心 = 8）：
 * 浮动按钮是 `align-items:center` 的 flex，居中的是**画布盒子**，
 * 画布内偏一点，图标就整体偏一点。老路径 y 占 1.2~12.4（中心 6.8），
 * 星形于是比右边「解读」两个字高了 1.1px（用户报的"✦ 和 解读 没对齐"）。
 * 同理 x 占 2.4~13.6（中心 8，本来就对称）—— 横向那点偏差交给 CSS 的负外边距。
 */
export function sparkleIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M8 2.4l1.5 4.1 4.1 1.5-4.1 1.5L8 13.6 6.5 9.5 2.4 8l4.1-1.5L8 2.4z')
  svg.appendChild(path)
  return svg
}

/**
 * 引用浮标上的图标：两个引号块（❝ 的简化画法）。
 * 用圆 + 左下角甩出的小尾巴拼 —— 13px 下也认得出，不依赖系统有没有那个字形。
 */
export function quoteIcon() {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  var marks = [
    { cx: 5.4, cy: 6.1, tail: 'M3.9 7.4 2.1 12.2 6.1 10.2z' },
    { cx: 11.6, cy: 6.1, tail: 'M10.1 7.4 8.3 12.2 12.3 10.2z' },
  ]
  for (var i = 0; i < marks.length; i += 1) {
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('cx', String(marks[i].cx))
    dot.setAttribute('cy', String(marks[i].cy))
    dot.setAttribute('r', '2.3')
    svg.appendChild(dot)
    var tail = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    tail.setAttribute('d', marks[i].tail)
    svg.appendChild(tail)
  }
  return svg
}

/**
 * 附件入口：十字（＋）。
 *
 * 为什么是十字不是回形针：十字在**工具行最左**、圆形浅底，和主会话 composer 的 ＋ 同款；
 * 回形针在这个位置会让人以为是"引用"（小窗里已经有一个 ❝ 引用）。
 * 两者含义本来就一样（都开系统文件选择器，图片和文件一起选），换形状只是位置带来的可读性。
 */
export function plusIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M8 3.4v9.2M3.4 8h9.2')
  return svg
}

/** 文件（通用文件卡左侧的文档图标）：一张带折角的纸。 */
export function docIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M4.3 1.9h4.4l3 3v9.2H4.3z')
  iconPath(svg, 'M8.5 1.9v3.2h3.2')
  return svg
}

/** 图片（缩略图加载失败时的占位）：方框 + 一点远山。 */
export function imageIcon() {
  var svg = iconCanvas(14)
  iconPath(svg, 'M2.6 3.2h10.8v9.6H2.6z')
  var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  dot.setAttribute('cx', '5.7')
  dot.setAttribute('cy', '6.3')
  dot.setAttribute('r', '0.9')
  svg.appendChild(dot)
  iconPath(svg, 'M2.6 10.9l3.1-2.9 2.5 2.3 2.3-2.1 2.9 2.7')
  return svg
}

/** 重试（失败附件卡上的小箭头圈）。 */
export function retryIcon() {
  var svg = iconCanvas(13)
  iconPath(svg, 'M12.6 8a4.6 4.6 0 1 1-1.6-3.5')
  iconPath(svg, 'M12.9 2.6v3.1h-3.1')
  return svg
}