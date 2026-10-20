/** Result snapshots are bounded independently of the complete saved conversation. */
export function createResultCache(maxEntries = 20, maxBytes = 8 * 1024 * 1024) {
  const entries = new Map()
  let textBytes = 0
  let disposed = false
  function remove(key) {
    const entry = entries.get(key)
    if (!entry) return
    textBytes -= entry.bytes
    entries.delete(key)
  }
  const cache = {
    get size() { return entries.size },
    // Conservative UTF-16 size of serialized text, not a measurement of JS heap size.
    get textBytes() { return textBytes },
    keys() { return entries.keys() },
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return JSON.parse(entry.json)
    },
    set(key, value) {
      if (disposed) return cache
      remove(key)
      let json
      try { json = JSON.stringify(value) } catch { return cache }
      if (typeof json !== 'string') return cache
      const bytes = (String(key).length + json.length) * 2
      if (bytes > maxBytes || maxEntries <= 0) return cache
      entries.set(key, { json, bytes })
      textBytes += bytes
      while (entries.size > maxEntries || textBytes > maxBytes) remove(entries.keys().next().value)
      return cache
    },
    clear() { entries.clear(); textBytes = 0 },
    dispose() { disposed = true; cache.clear() },
  }
  return cache
}

/** Own only active timers; completed/cancelled callbacks never accumulate in a registry. */
export function createTimerScope() {
  const active = new Set()
  let disposed = false
  return {
    get size() { return active.size },
    later(fn, ms) {
      if (disposed) return null
      const id = setTimeout(() => {
        active.delete(id)
        if (!disposed) fn()
      }, ms)
      active.add(id)
      return id
    },
    interval(fn, ms) {
      if (disposed) return null
      const id = setInterval(fn, ms)
      active.add(id)
      return id
    },
    clear(id) {
      clearTimeout(id)
      clearInterval(id)
      active.delete(id)
    },
    dispose() {
      disposed = true
      active.forEach(id => { clearTimeout(id); clearInterval(id) })
      active.clear()
    },
  }
}
