/**
 * 生成"圆点 ⇄ 星芒"的两条 SVG path（写进 src/client/index.js 的 PILL_STAR_DOT_D / PILL_STAR_D）。
 *
 * 为什么是这两条：
 *   「✦ 解读」浮标里那颗星是 16 画布上的八边形 —— 外半径 5.6、内半径 2.1213（内外比 .3788），四条边是**直线**
 *   （path: M8 2.4l1.5 4.1 4.1 1.5-4.1 1.5L8 13.6 6.5 9.5 2.4 8l4.1-1.5L8 2.4z）。
 *   球里按 8.4/5.6 = 1.5 倍放大（墨迹 16.8px），并把"圆"和"星"都看成 32 边形逐顶点插值：
 *     · 32 个顶点按 11.25° 取样；星那条边上的取样点由射线与多边形求交得到，精确落在线段上
 *     · p=0：32 个顶点同半径 4 → 8px 圆点（8px 下与正圆无差，最大偏差 0.02px）
 *     · p=1：32 个顶点正好是星边界（尖与谷仍是精确顶点）→ 与按钮那条 path 逐点相同（仅放大 1.5 倍）
 *   两条 path 命令结构一致（M + 31×L + Z），所以 Chrome 能对 d 做插值。
 *
 * 用法：node scripts/gen-star-path.mjs
 */
var TIP = 6.0   // 墨迹 12.0px = 胶囊里文字的字号（用户要求：和文字一样高）
var VALLEY = TIP * 0.3788
var SAMPLES = 32

function polar(angDeg, r) {
  var a = (angDeg * Math.PI) / 180
  return { x: r * Math.cos(a), y: r * Math.sin(a) }
}
function starPolygon() {
  var pts = []
  for (var k = 0; k < 4; k += 1) {
    pts.push(polar(k * 90, TIP))
    pts.push(polar(k * 90 + 45, VALLEY))
  }
  return pts
}
function cross(ax, ay, bx, by) { return ax * by - ay * bx }
function boundaryRadius(poly, angDeg) {
  var d = polar(angDeg, 1)
  var best = Infinity
  for (var i = 0; i < poly.length; i += 1) {
    var p0 = poly[i]
    var p1 = poly[(i + 1) % poly.length]
    var ex = p1.x - p0.x
    var ey = p1.y - p0.y
    var den = cross(d.x, d.y, ex, ey)
    if (Math.abs(den) < 1e-9) continue
    var t = cross(p0.x, p0.y, ex, ey) / den
    var u = cross(p0.x, p0.y, d.x, d.y) / den
    if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t
  }
  return best === Infinity ? 4 : best
}
function pathFor(radiusOf) {
  var poly = starPolygon()
  var out = []
  for (var i = 0; i < SAMPLES; i += 1) {
    var ang = (i * 360) / SAMPLES
    var r = radiusOf(boundaryRadius(poly, ang))
    var pt = polar(ang, r)
    out.push((i ? 'L' : 'M') + round(pt.x) + ' ' + round(pt.y))
  }
  return out.join('') + 'Z'
}
function round(v) { return String(Math.round(v * 100) / 100) }

var DOT = pathFor(function () { return 4 })
var STAR = pathFor(function (r) { return r })

console.log('// p=0（8px 圆点）：')
console.log("var PILL_STAR_DOT_D = '" + DOT + "'")
console.log('')
console.log('// p=1（按钮那颗星，放大 1.5 倍）：')
console.log("var PILL_STAR_D = '" + STAR + "'")
console.log('')
console.log('// 长度: DOT ' + DOT.length + ' 字符, STAR ' + STAR.length + ' 字符')
console.log('// 命令结构一致（可插值）: ' + (DOT.split(/[MLZ]/).length === STAR.split(/[MLZ]/).length))
