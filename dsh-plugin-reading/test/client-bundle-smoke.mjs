/**
 * Client bundle smoke test: materialise client.js in a fake page realm, run the
 * plugin `apply`, and assert the slot/locale registrations the page depends on.
 *
 *   node test/client-bundle-smoke.mjs
 *
 * This catches missing globals, bad registration shapes and apply-time throws
 * before the bundle is installed into a live profile (the components themselves
 * are only exercised in the real browser).
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { createContext, runInContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = await fs.readFile(join(here, '..', 'client.js'), 'utf8')

let loaded = null
const registrations = []
const dictionaries = []
const effects = []
const listeners = []

const fakeReact = {
  createElement: (type, props, ...children) => ({ $$typeof: 'element', type, props: { ...props, children } }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, get) => get(),
  memo: (component) => component,
  forwardRef: (render) => render,
  Fragment: Symbol('Fragment'),
}

const localeService = {
  register(namespace, dict) {
    dictionaries.push({ namespace, dict })
    return () => {}
  },
  bind: () => (key) => key,
  getLocale: () => ({ locale: 'zh' }),
  subscribe: (fn) => {
    listeners.push(fn)
    return () => {}
  },
}

const slotsService = {
  inject(key, callback) {
    const inner = callback()
    return () => inner?.()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
}

const clientStore = {
  get: () => ({ entries: [], hasMore: false, revision: 0 }),
  subscribe: () => () => {},
}

const ctx = {
  get(name) {
    if (name === 'locale') return localeService
    if (name === 'connection') {
      return {
        rpc: { call: async () => ({ ok: true, value: {} }) },
        state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
      }
    }
    if (name === 'uiWorkspace') return { startSession: () => {} }
    if (name === 'workspaces') return { list: clientStore }
    if (name === 'resources') return { register: () => () => {} }
    return undefined
  },
  effect(callback, label) {
    const dispose = callback()
    effects.push({ label, dispose })
    return dispose
  },
  slots: slotsService,
  provide() {},
  on() {
    return () => {}
  },
}

const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
  addEventListener() {},
  removeEventListener() {},
}

const sandbox = {
  window: windowStub,
  globalThis: null,
  document: {
    baseURI: 'http://127.0.0.1:1/',
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, style: {}, remove() {}, appendChild() {}, click() {} }),
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  },
  location: { origin: 'http://127.0.0.1:1' },
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  TextDecoder,
  TextEncoder,
  URL,
  Blob: class {},
  AbortController,
  fetch: async () => {
    throw new Error('network disabled in smoke test')
  },
  navigator: { clipboard: { writeText: async () => {} } },
  React: undefined,
}
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(bundle, sandbox, { filename: 'client.js' })
assert.ok(loaded, 'bundle registered a loader factory')
assert.equal(loaded.id, '@local/dsh-reading', 'bundle id matches package name')

const factory = loaded.factory
const plugin = factory((request) => {
  if (request === 'react') return fakeReact
  throw new Error(`unexpected module request: ${request}`)
})
assert.ok(plugin && typeof plugin.apply === 'function', 'factory returned a plugin with apply')
assert.ok(Array.isArray(plugin.inject), 'plugin declares inject list')
console.log(`ok - bundle materialises (id=${loaded.id}, inject=${plugin.inject.join(',')})`)

plugin.apply(ctx)
console.log('ok - apply() runs without throwing')

const main = registrations.find((entry) => entry.options.name === 'main')
assert.ok(main, 'main panel registered')
assert.equal(main.options.key, 'reading', 'main panel key is reading')
assert.equal(main.options.locale, 'reading', 'main panel uses the reading locale namespace')
assert.equal(typeof main.component, 'function', 'main panel has a component')

const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(sidebar, 'sidebar entry registered')
assert.equal(sidebar.options.id, 'reading', 'sidebar entry id matches the main key')
assert.equal(typeof sidebar.options.label, 'function', 'sidebar label is locale-aware')
assert.equal(sidebar.options.label(), '阅读', 'sidebar label resolves in Chinese')
assert.equal(typeof sidebar.component, 'function', 'sidebar entry has an icon component')
console.log('ok - main panel + sidebar entry registered with matching ids')

const dict = dictionaries.find((entry) => entry.namespace === 'reading')
assert.ok(dict, 'locale dictionary registered under the reading namespace')
assert.ok(dict.dict.zh && dict.dict.en, 'dictionary carries zh and en')
assert.equal(dict.dict.zh['shelf.title'], '阅读')
assert.equal(dict.dict.en['shelf.title'], 'Reading')
console.log('ok - locale dictionary registered')

assert.ok(effects.length >= 1, 'locale registration is owned by an effect')
console.log('ok - registrations are effect-owned')

const sidebarIcon = sidebar.component
const iconElement = sidebarIcon({ size: 16, active: true })
assert.ok(iconElement, 'sidebar icon renders an element')
console.log('ok - sidebar icon renders with shell props')

console.log('\nclient bundle smoke test passed')
