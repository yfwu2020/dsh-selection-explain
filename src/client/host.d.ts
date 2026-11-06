/** Browser extensions supplied by DSH and older WebKit engines. */
interface Window {
  webkitAudioContext?: typeof AudioContext
  webkitOfflineAudioContext?: typeof OfflineAudioContext
  __dshSelBridge?: boolean | number
  /** Internal debug surface; methods are intentionally open for host automation. */
  __dshSelectionExplain?: Record<string, (...args: any[]) => any>
  /**
   * 当前这一代实例的清理函数（幂等）。
   * 客户端热更新 / 重复挂载时，新 apply() 先调它，避免上一代残留出第二个「解读」按钮。
   */
  __dshSelectionExplainDispose?: () => void
}

/** The client uses only the host-provided React element constructor. */
declare module 'react' {
  const React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  }
  export default React
}
