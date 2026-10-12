/** Browser extensions supplied by DSH and older WebKit engines. */
interface Window {
  webkitAudioContext?: typeof AudioContext
  webkitOfflineAudioContext?: typeof OfflineAudioContext
  __dshSelBridge?: boolean | number
  /** Internal debug surface; methods are intentionally open for host automation. */
  __dshSelectionExplain?: Record<string, (...args: any[]) => any>
}

/** The client uses only the host-provided React element constructor. */
declare module 'react' {
  const React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  }
  export default React
}
