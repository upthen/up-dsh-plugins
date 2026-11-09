/**
 * Shared client bundle preamble.
 *
 * Every `client-src/*.js` part is concatenated inside one loader factory, so the
 * bindings declared here are visible to all later parts. The factory receives the
 * platform module table through `require`; React is the only non-baseline runtime
 * import this plugin needs.
 */
const React = require('react')
const h = React.createElement
const useState = React.useState
const useEffect = React.useEffect
const useMemo = React.useMemo
const useRef = React.useRef
const useCallback = React.useCallback
const useLayoutEffect = React.useLayoutEffect
const useSyncExternalStore = React.useSyncExternalStore

/** Translation seat, assigned in 30-store after the Client locale service is read. */
let translate = (key) => key

/** Translate one dictionary key, falling back to the key itself. */
function t(key) {
  try {
    return translate(key) || key
  } catch {
    return key
  }
}

/** Collect page-private stylesheet text contributed by any part. */
const STYLE_PARTS = []

/** Register one stylesheet chunk; called at materialisation time. */
function addStyles(css) {
  if (typeof css === 'string' && css.trim().length > 0) STYLE_PARTS.push(css.trim())
}

/** Mount the collected stylesheet text as one removable <style> element. */
function StyleSheet() {
  const css = useMemo(() => STYLE_PARTS.join('\n'), [])
  useEffect(() => {
    const element = document.createElement('style')
    element.dataset.readingStyles = 'reading'
    element.textContent = css
    document.head.appendChild(element)
    return () => element.remove()
  }, [css])
  return null
}

/** Create a tiny external store readable through `useSyncExternalStore`. */
function createStore(initial) {
  let state = initial
  const listeners = new Set()
  const get = () => state
  const set = (updater) => {
    const next = typeof updater === 'function' ? updater(state) : updater
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener()
  }
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return { get, set, subscribe }
}

/** Subscribe one component to a store. */
function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Join class names, dropping falsy entries. */
function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/** Clamp a number into a range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Debounce a function and keep a disposer on the returned wrapper. */
function debounce(fn, delay) {
  let timer
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
  wrapped.cancel = () => clearTimeout(timer)
  wrapped.flush = (...args) => {
    clearTimeout(timer)
    fn(...args)
  }
  return wrapped
}

/** Format an epoch value for the shelf and note rows. */
function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** Escape a string for safe inclusion in a regular expression. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
