

/** 插件名（= package.json name，客户端 bundle 的模块 id 也是它）。 */
export const name = '@yfwu2020/dsh-selection-explain'

/**
 * 升格时那条「上下文注入」消息的 `source.kind` —— 生产者**自有**的来源标识。
 *
 * 会话格式 v4 起（本机实测内核 0.2.0-rc.2），消息来源必须是生产者自报的 kind；
 * v3 那种 `plugin` 包装（`kind: 'plugin'` 配一个 `plugin` 字段）已经退役，会被
 * v4 准入当场拒掉：
 *   SessionFormatError: format v4 message requires a producer-owned source kind
 * 症状极具迷惑性：`↗ 升格` 的 HTTP 请求返回 `ok: true`（那时只写进了内存里的会话面），
 * 随后那轮 opener 运行失败、整个 artifact 一个字都没落盘 —— 新会话只剩表头。
 * 离线测试也照样全绿（校验发生在真实内核里，不在构建期），所以另配了
 * tests/unit/format.test.mjs 钉住这个 shape。
 *
 * 第三方插件的规范形态是 `plugin:<插件名>`：内核 v3→v4 迁移把那种 `plugin` 包装
 * 重写成 `plugin:<完整插件名>`（`producerKind()` 对不在同名表里的插件就是这么算的），
 * 所以这里写的与迁移结果逐字节一致 —— 新旧会话归因相同，且 v3 内核下同样合法
 * （直写的 kind 迁移时原样保留）。
 */
export const PLUGIN_SOURCE_KIND = `plugin:${name}`

/** 路由注册与模型调用所需的服务。 */
export const inject = ['webServer', 'llm']

/** 路由前缀。 */
export const API_PREFIX = '/selection-explain/api'
