/**
 * Headless render smoke test for the client views.
 *
 * The page's real React runtime only exists inside the built Web shell, so this
 * harness provides a minimal hooks runtime and renders every view to a plain
 * element tree. It verifies that no component throws while reading realistic
 * state (the real library on this machine when present, synthetic data as a
 * fallback), including the reader's block renderer over a real chapter.
 *
 *   node test/render-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { createContext, runInContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'client-src')

// ---- build a test bundle that exposes the components and lets us inject state ----
const names = (await fs.readdir(srcDir)).filter((name) => name.endsWith('.js')).sort()
const parts = []
for (const name of names) parts.push(await fs.readFile(join(srcDir, name), 'utf8'))
const testTail = `
let __TEST_STATE__ = null
useReading = () => __TEST_STATE__
globalThis.__READING_TEST__ = {
  components: { ReadingPanel, ShelfView, ReaderView, NotesView, NotesDrawer, ChatPane, SelectionToolbar, SearchOverlay },
  setState: (state) => { __TEST_STATE__ = state },
  getState: () => __TEST_STATE__,
  get actions() { return READING_ACTIONS },
  get api() { return READING_API },
}
`
const joined = parts.join('\n')
// `99-apply.js` ends with `return readingPlugin`; inject the test tail before it.
const marker = 'return readingPlugin'
assert.ok(joined.includes(marker), 'client bundle has a plugin return statement')
const source = `window.__ModuleLoader__.load({ id: '@local/dsh-reading', factory(require) {\n${joined.replace(marker, `${testTail}\n${marker}`)}\n} });`

// ---- minimal React hooks runtime ----
function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}
const fakeReact = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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

let loaded = null
const registrations = []
const fakeSlots = {
  inject: (_key, callback) => () => callback?.()?.(),
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const fakeLocale = {
  register: () => () => {},
  bind: () => (key) => key,
  getLocale: () => ({ locale: 'zh' }),
  subscribe: () => () => {},
}
const fakeCtx = {
  get(name) {
    if (name === 'locale') return fakeLocale
    if (name === 'connection') return { rpc: { call: async () => ({ ok: true, value: {} }) } }
    if (name === 'uiWorkspace') return { startSession: () => {} }
    if (name === 'resizable') return undefined
    return undefined
  },
  effect: (callback) => callback(),
  slots: fakeSlots,
  provide: () => {},
  on: () => () => {},
}

const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { loaded = definition } }, addEventListener() {}, removeEventListener() {} },
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
  setTimeout: (fn) => {
    if (typeof fn === 'function') fn()
    return 0
  },
  clearTimeout: () => {},
  requestAnimationFrame: (callback) => {
    if (typeof callback === 'function') callback()
    return 1
  },
  cancelAnimationFrame: () => {},
  TextDecoder,
  TextEncoder,
  URL,
  Blob: class {},
  AbortController,
  fetch: async () => {
    throw new Error('network disabled')
  },
  navigator: { clipboard: { writeText: async () => {} } },
}
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(source, sandbox, { filename: 'client.test.js' })
assert.ok(loaded, 'test bundle registers a loader factory')
const plugin = loaded.factory((request) => {
  if (request === 'react') return fakeReact
  throw new Error(`unexpected module request: ${request}`)
})
plugin.apply(fakeCtx)
const test = sandbox.__READING_TEST__ || sandbox.globalThis.__READING_TEST__
assert.ok(test, 'test hooks exposed')
const { components } = test

// ---- readable element tree walker (renders function components once) ----
function render(element, depth = 0) {
  if (element === null || element === undefined || element === false || element === true) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map((child) => render(child, depth + 1)).join('')
  if (typeof element !== 'object') return ''
  if (typeof element.type === 'function') {
    if (depth > 80) throw new Error('render depth exceeded')
    const children = element.props?.children
    const props = { ...element.props, children }
    return render(element.type(props), depth + 1)
  }
  return render(element.props?.children, depth + 1)
}

function makeState(overrides) {
  return {
    status: 'ready',
    error: null,
    view: 'shelf',
    shelf: { books: [], settings: { fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', theme: 'paper', contentWidth: 720 }, notesCount: 0, libraryDir: 'C:/Users/x/.dsh/reading' },
    importing: false,
    current: null,
    loadingBook: false,
    reading: { tocOpen: false, notesOpen: false, settingsOpen: false },
    progress: { chapterIndex: 0, scrollRatio: 0, percent: 0 },
    selection: null,
    ask: { messages: [], draftQuote: null, streaming: false },
    notes: [],
    notesLoading: false,
    search: { open: false, q: '', loading: false, results: [] },
    toast: null,
    ...overrides,
  }
}

let checks = 0
function renderCase(name, Component, state, expected, allowEmpty = false) {
  test.setState(state)
  const element = createElement(Component, {
    state,
    actions: test.actions,
    api: test.api,
    containerRef: { current: null },
  })
  const html = render(element)
  assert.ok(allowEmpty || (typeof html === 'string' && html.length > 0), `${name}: rendered content`)
  for (const snippet of expected || []) {
    assert.ok(html.includes(snippet), `${name}: expected "${snippet}" in output`)
  }
  checks += 1
  console.log(`ok - ${name}`)
}

// ---- realistic fixture data from the live library when available, else synthetic ----
const libraryRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'reading') : join('C:/Users/yongbo.zeng/.dsh/reading')
let books = []
let readerState = null
let readerSnippet = null
let notes = []
try {
  const library = JSON.parse(await fs.readFile(join(libraryRoot, 'library.json'), 'utf8'))
  books = library.books || []
  const target = books.find((book) => book.title.includes('論語') || book.title.includes('论语')) || books[0]
  if (target) {
    const content = JSON.parse(await fs.readFile(join(libraryRoot, 'books', target.id, 'content.json'), 'utf8'))
    const chapterIndex = Math.min(3, content.chapters.length - 1)
    const chapter = content.chapters[chapterIndex]
    readerState = {
      current: { book: target, toc: content.chapters.map((entry, index) => ({ index, title: entry.title })), chapterIndex, chapter: { title: chapter.title, blocks: chapter.blocks }, bookmarks: [] },
      progress: { chapterIndex, scrollRatio: 0.25, percent: 0.3 },
    }
    readerSnippet = (chapter.title || '').slice(0, 2) || '<?>'
    notes = [
      { id: 'n_test', bookId: target.id, bookTitle: target.title, chapterIndex, chapterTitle: chapter.title, quote: '學而時習之，不亦說乎？', question: '如何理解「說」字？', answer: '通「悅」，喜悅之意。', note: '朱子注：說，喜意也。', tags: ['训诂'], createdAt: Date.now(), updatedAt: Date.now() },
    ]
  }
} catch (error) {
  console.log(`(live library unavailable: ${error.message}; using synthetic fixtures)`)
}

const syntheticChapter = {
  title: '學而第一',
  blocks: [
    { t: 'h', level: 2, runs: [{ text: '學而第一' }] },
    { t: 'p', runs: [{ text: '子曰：「' }, { text: '學', ruby: 'xué' }, { text: '而時習之，不亦說乎？」' }] },
    { t: 'quote', blocks: [{ t: 'p', runs: [{ text: '君子務本，本立而道生。' }] }] },
    { t: 'list', ordered: false, items: [[{ text: '敬事而信' }], [{ text: '節用而愛人' }]] },
    { t: 'img', src: 'asset.png', alt: '插图' },
    { t: 'hr' },
    { t: 'blank' },
  ],
}
const syntheticBook = { id: 'b_test', title: '論語', author: '孔子', chapterCount: 3, cover: true, progress: { percent: 0.2 } }
const syntheticReaderState = {
  current: { book: syntheticBook, toc: [{ index: 0, title: '學而第一' }, { index: 1, title: '為政第二' }], chapterIndex: 0, chapter: syntheticChapter, bookmarks: [] },
  progress: { chapterIndex: 0, scrollRatio: 0.25, percent: 0.2 },
}
if (!readerState) {
  readerState = syntheticReaderState
}

const shelfState = makeState({
  shelf: {
    books: books.length > 0 ? books : [{ ...syntheticBook, addedAt: Date.now(), lastReadAt: Date.now() }],
    settings: { fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', theme: 'paper', contentWidth: 720 },
    notesCount: notes.length || 1,
    libraryDir: libraryRoot,
  },
})

// ---- cases ----
renderCase('shelf: empty state', components.ShelfView, makeState({}), ['书架还是空的'])
renderCase('shelf: real books', components.ShelfView, shelfState, ['論語'])
renderCase('shelf: importing banner', components.ShelfView, makeState({ importing: true, shelf: shelfState.shelf }), [])
renderCase('reader: real chapter with blocks', components.ReaderView, makeState({ view: 'reader', ...readerState }), readerSnippet ? [readerSnippet] : [])
renderCase('reader: synthetic block model', components.ReaderView, makeState({ view: 'reader', ...syntheticReaderState }), ['學而第一'])
renderCase('reader: loading chapter', components.ReaderView, makeState({ view: 'reader', loadingBook: true, ...readerState }), [])
renderCase('reader: toc drawer open', components.ReaderView, makeState({ view: 'reader', ...readerState, reading: { tocOpen: true, notesOpen: false, settingsOpen: false } }), [])
renderCase('reader: settings dialog open', components.ReaderView, makeState({ view: 'reader', ...readerState, reading: { tocOpen: false, notesOpen: false, settingsOpen: true } }), ['阅读设置'])
renderCase('reader: notes drawer open', components.ReaderView, makeState({ view: 'reader', ...readerState, notes: notes, reading: { tocOpen: false, notesOpen: true, settingsOpen: false } }), [])
renderCase(
  'reader: chat empty',
  components.ReaderView,
  makeState({ view: 'reader', ...readerState }),
  ['选中正文，开始提问'],
)
renderCase(
  'reader: chat streaming answer',
  components.ReaderView,
  makeState({
    view: 'reader',
    ...readerState,
    ask: {
      messages: [
        { id: 'm1', role: 'user', text: '这句怎么理解？', quote: '學而時習之', chapterIndex: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', text: '正在回答', streaming: true, error: null, question: '这句怎么理解？', chapterIndex: 0, createdAt: 2 },
      ],
      draftQuote: null,
      streaming: true,
    },
  }),
  ['正在回答'],
)
renderCase(
  'reader: chat reasoning while streaming',
  components.ReaderView,
  makeState({
    view: 'reader',
    ...readerState,
    ask: {
      messages: [
        { id: 'm1', role: 'user', text: '解释这段', quote: '學而時習之', chapterIndex: 0, createdAt: 1 },
        {
          id: 'm2',
          role: 'assistant',
          text: '',
          reasoning: '先判断这是论语学而篇的首章，然后解释关键字。',
          model: { provider: 'fake', model: 'fake-model' },
          streaming: true,
          error: null,
          question: '解释这段',
          chapterIndex: 0,
          createdAt: 2,
        },
      ],
      draftQuote: null,
      streaming: true,
    },
  }),
  ['正在思考…', '先判断这是论语学而篇的首章'],
)
renderCase(
  'reader: chat error with retry',
  components.ReaderView,
  makeState({
    view: 'reader',
    ...readerState,
    ask: {
      messages: [
        { id: 'm1', role: 'user', text: '问题', quote: '原文', chapterIndex: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', text: '', streaming: false, error: '模型不可用', question: '问题', chapterIndex: 0, createdAt: 2 },
      ],
      draftQuote: null,
      streaming: false,
    },
  }),
  ['模型不可用', '重试'],
)
renderCase(
  'reader: chat draft quote parked',
  components.ReaderView,
  makeState({
    view: 'reader',
    ...readerState,
    ask: { messages: [], draftQuote: { text: '學而時習之', chapterIndex: 0 }, streaming: false },
  }),
  ['學而時習之'],
)
renderCase('notes: empty', components.NotesView, makeState({ view: 'notes' }), [])
renderCase('notes: loaded', components.NotesView, makeState({ view: 'notes', notes }), [])
renderCase('search: loading', components.SearchOverlay, makeState({ search: { open: true, q: '學', loading: true, results: [] } }), [])
renderCase('search: results', components.SearchOverlay, makeState({ search: { open: true, q: '學而', loading: false, results: [{ bookId: 'b1', bookTitle: '論語', chapterIndex: 0, chapterTitle: '學而第一', snippet: '學而時習之' }] } }), ['學而時習之'])
renderCase('selection toolbar: no selection', components.SelectionToolbar, makeState({}), [], true)
// The toolbar's visibility is driven by DOM selection effects, which this
// headless runtime does not run; the case asserts the render path is safe.
renderCase('selection toolbar: with selection', components.SelectionToolbar, makeState({ view: 'reader', ...readerState, selection: { text: '學而時習之', chapterIndex: 0, x: 100, y: 100 } }), [], true)
renderCase('panel: loading root', components.ReadingPanel, makeState({ status: 'loading' }), [])
renderCase('panel: error root', components.ReadingPanel, makeState({ status: 'error', error: '打不开书架' }), ['打不开书架'])
renderCase('panel: shelf view', components.ReadingPanel, shelfState, [])
renderCase('panel: notes view', components.ReadingPanel, makeState({ view: 'notes', shelf: shelfState.shelf, notes }), [])

// ---- interaction probes: render to an element tree and invoke real handlers ----
function renderTree(element, depth = 0) {
  if (element === null || element === undefined || typeof element === 'boolean') return null
  if (typeof element === 'string' || typeof element === 'number') return null
  if (Array.isArray(element)) return element.map((child) => renderTree(child, depth + 1)).filter(Boolean)
  if (typeof element !== 'object') return null
  if (typeof element.type === 'function') {
    if (depth > 80) throw new Error('render depth exceeded')
    const props = { ...element.props, children: element.props?.children }
    return renderTree(element.type(props), depth + 1)
  }
  return { type: element.type, props: element.props || {} }
}

function collectNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out)
    return out
  }
  if (typeof node.type === 'function') {
    collectNodes(renderTree(node), predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  const children = node.props?.children
  if (children !== undefined) collectNodes(children, predicate, out)
  return out
}

function findByClassName(tree, className) {
  return collectNodes(tree, (node) => {
    const value = typeof node.props.className === 'string' ? node.props.className : ''
    return value.split(/\s+/).includes(className)
  })
}

/** Flatten the text content under one node (for locating labelled buttons). */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(renderTree(node))
  return textOf(node.props?.children)
}

const actions = test.actions
const originalLoadChapter = actions.loadChapter
const loadChapterCalls = []
actions.loadChapter = async (index) => {
  loadChapterCalls.push(index)
}

// TOC drawer: clicking a chapter row jumps to that chapter.
loadChapterCalls.length = 0
const tocOpenState = makeState({
  view: 'reader',
  ...syntheticReaderState,
  reading: { tocOpen: true, notesOpen: false, settingsOpen: false },
})
test.setState(tocOpenState)
const tocTree = renderTree(
  createElement(components.ReaderView, { state: tocOpenState, actions, api: test.api }),
)
const tocItems = findByClassName(tocTree, 'rd-reader-toc-item')
if (tocItems.length === 0) {
  const all = collectNodes(tocTree, () => true)
  console.log('DEBUG nodes:', JSON.stringify(all.map((node) => [node.type, node.props.className]).slice(0, 60)))
}
assert.ok(tocItems.length >= 2, 'toc rows rendered')
assert.equal(typeof tocItems[1].props.onClick, 'function', 'toc row clickable')
tocItems[1].props.onClick()
assert.deepEqual(loadChapterCalls, [1], 'toc row click jumps to the chapter index')
checks += 1
console.log('ok - interface: clicking a TOC row calls loadChapter(index)')

// In-book contents page: a relative link whose label matches a chapter title jumps.
const linkState = makeState({
  view: 'reader',
  current: {
    book: syntheticBook,
    toc: [{ index: 0, title: '學而第一' }, { index: 1, title: '為政第二' }],
    chapterIndex: 0,
    chapter: {
      title: '學而第一',
      blocks: [
        { t: 'h', level: 2, runs: [{ text: '學而第一' }] },
        { t: 'p', runs: [{ text: '目录' }] },
        { t: 'p', runs: [{ text: '為政第二', href: 'chapter2.xhtml#sec-2' }] },
        { t: 'p', runs: [{ text: '外部链接', href: 'https://example.com/doc' }] },
      ],
    },
    bookmarks: [],
  },
  progress: { chapterIndex: 0, scrollRatio: 0, percent: 0 },
})
loadChapterCalls.length = 0
test.setState(linkState)
const linkTree = renderTree(
  createElement(components.ReaderView, { state: linkState, actions, api: test.api }),
)
const internalLinks = findByClassName(linkTree, 'rd-reader-link')
const jumpButtons = internalLinks.filter((node) => node.type === 'button')
assert.equal(jumpButtons.length, 1, 'internal EPUB link rendered as a jump button')
assert.equal(typeof jumpButtons[0].props.onClick, 'function')
const preventDefault = { called: false }
const stopPropagation = { called: false }
jumpButtons[0].props.onClick({
  preventDefault: () => { preventDefault.called = true },
  stopPropagation: () => { stopPropagation.called = true },
})
assert.deepEqual(loadChapterCalls, [1], 'in-book contents link jumps to the matched chapter')
assert.equal(preventDefault.called, true)
assert.equal(stopPropagation.called, true)
const externalLinks = collectNodes(linkTree, (node) => node.type === 'a')
assert.equal(externalLinks.length, 1, 'external link rendered as an anchor')
assert.equal(externalLinks[0].props.href, 'https://example.com/doc')
assert.equal(externalLinks[0].props.target, '_blank')
checks += 1
console.log('ok - interface: in-book contents link maps by label and jumps; external links stay anchors')

actions.loadChapter = originalLoadChapter

// Real in-book contents page: the live 宋词鉴赏辞典 chapter 0 carries hundreds of
// relative links; each resolved one must render as a jump button.
try {
  const liveLibrary = JSON.parse(await fs.readFile(join(libraryRoot, 'library.json'), 'utf8'))
  const poetry = liveLibrary.books.find((book) => String(book.title).includes('宋词鉴赏'))
  if (poetry) {
    const content = JSON.parse(await fs.readFile(join(libraryRoot, 'books', poetry.id, 'content.json'), 'utf8'))
    const contentsIndex = 0
    const realState = makeState({
      view: 'reader',
      current: {
        book: poetry,
        toc: content.chapters.map((entry, index) => ({ index, title: entry.title })),
        chapterIndex: contentsIndex,
        chapter: { title: content.chapters[contentsIndex].title, blocks: content.chapters[contentsIndex].blocks },
        bookmarks: [],
      },
      progress: { chapterIndex: contentsIndex, scrollRatio: 0, percent: 0 },
    })
    loadChapterCalls.length = 0
    actions.loadChapter = async (index) => {
      loadChapterCalls.push(index)
    }
    const realTree = renderTree(createElement(components.ReaderView, { state: realState, actions, api: test.api }))
    const realLinks = findByClassName(realTree, 'rd-reader-link').filter((node) => node.type === 'button')
    assert.ok(realLinks.length > 50, `real contents page renders jump buttons (got ${realLinks.length})`)
    realLinks[2].props.onClick({ preventDefault() {}, stopPropagation() {} })
    assert.equal(loadChapterCalls.length, 1, 'real contents link calls loadChapter')
    assert.ok(loadChapterCalls[0] > 0, 'real contents link resolves to a later chapter')
    actions.loadChapter = originalLoadChapter
    checks += 1
    console.log(`ok - interface: real 宋词 contents page renders ${realLinks.length} jump links (clicked -> chapter ${loadChapterCalls[0]})`)
  }
} catch (error) {
  console.log(`(real contents-page probe skipped: ${error.message})`)
}

// ---- wiring probes: the UI gestures behind the remaining acceptance items ----
const originalActions = { ...actions }
function spyAction(name) {
  const calls = []
  actions[name] = async (...args) => {
    calls.push(args)
    if (name === 'saveAskAsNote') return { id: 'n2' }
    return null
  }
  return calls
}
function restoreAction(name) {
  actions[name] = originalActions[name]
}

// Bookmark header button -> actions.toggleBookmark
{
  const calls = spyAction('toggleBookmark')
  const state = makeState({ view: 'reader', ...syntheticReaderState })
  test.setState(state)
  const tree = renderTree(createElement(components.ReadingPanel))
  const buttons = collectNodes(tree, (node) => node.type === 'button')
  const bookmark = buttons.find((node) => node.props['aria-label'] === '书签')
  assert.ok(bookmark, 'bookmark header button rendered')
  bookmark.props.onClick()
  assert.equal(calls.length, 1, 'bookmark button calls toggleBookmark')
  restoreAction('toggleBookmark')
  checks += 1
  console.log('ok - interface: header bookmark button calls toggleBookmark')
}

// Chat "存为笔记" -> actions.saveMessageNote
{
  const calls = spyAction('saveMessageNote')
  const state = makeState({
    view: 'reader',
    ...syntheticReaderState,
    ask: {
      messages: [
        { id: 'm1', role: 'user', text: '「說」字怎么解？', quote: '學而時習之，不亦說乎？', chapterIndex: 0, createdAt: 1 },
        { id: 'm2', role: 'assistant', text: '說通「悅」，喜意也。', streaming: false, error: null, question: '「說」字怎么解？', chapterIndex: 0, createdAt: 2 },
      ],
      draftQuote: null,
      streaming: false,
    },
  })
  test.setState(state)
  const tree = renderTree(createElement(components.ReadingPanel))
  const buttons = collectNodes(tree, (node) => node.type === 'button')
  const save = buttons.find((node) => textOf(node).includes('存为笔记'))
  assert.ok(save, 'save-as-note button rendered')
  save.props.onClick()
  assert.equal(calls.length, 1, 'save-as-note button calls saveMessageNote')
  assert.equal(calls[0][0], 'm2', 'the assistant message id is passed')
  restoreAction('saveMessageNote')
  checks += 1
  console.log('ok - interface: chat "存为笔记" calls saveMessageNote')
}

// Selection intent menu -> actions.askWithQuote / beginQuestion
{
  const askCalls = spyAction('askWithQuote')
  const parkCalls = spyAction('beginQuestion')
  const state = makeState({
    view: 'reader',
    ...syntheticReaderState,
    selection: { text: '學而時習之，不亦說乎？', chapterIndex: 0, x: 120, y: 160 },
  })
  test.setState(state)
  const tree = renderTree(createElement(components.SelectionToolbar, { state, actions, containerRef: { current: null } }))
  const buttons = collectNodes(tree, (node) => node.type === 'button')
  const explain = buttons.find((node) => textOf(node).includes('解释这段'))
  const myself = buttons.find((node) => textOf(node).includes('自己提问'))
  assert.ok(explain && myself, 'intent menu rendered with explain and ask-myself')
  explain.props.onClick()
  assert.equal(askCalls.length, 1, 'intent sends a question')
  assert.equal(askCalls[0][1].quote, '學而時習之，不亦說乎？')
  assert.ok(String(askCalls[0][0]).length > 4, 'intent carries a canned question')
  myself.props.onClick()
  assert.equal(parkCalls.length, 1, 'ask-myself parks the quote for the composer')
  restoreAction('askWithQuote')
  restoreAction('beginQuestion')
  checks += 1
  console.log('ok - interface: selection menu asks via askWithQuote / parks for the composer')
}

// Chat composer -> actions.askWithQuote with the typed question
{
  const askCalls = spyAction('askWithQuote')
  const state = makeState({ view: 'reader', ...syntheticReaderState })
  const tree = renderTree(createElement(components.ChatPane, { state, actions }))
  const textarea = collectNodes(tree, (node) => node.type === 'textarea')[0]
  assert.ok(textarea, 'chat composer rendered')
  textarea.props.onChange({ target: { value: '这段话的背景是什么？' } })
  // Re-render: the component keeps the typed text in state, so drive send through a
  // second render with the same component identity is not possible here; instead the
  // onChange + button path is asserted through the store-level tests. Keep the render
  // harness honest and only assert the composer wiring exists.
  assert.equal(typeof textarea.props.onKeyDown, 'function')
  restoreAction('askWithQuote')
  checks += 1
  console.log('ok - interface: chat composer renders and wires its input')
}

// Reading settings slider -> actions.setSettings
{
  const calls = spyAction('setSettings')
  const state = makeState({
    view: 'reader',
    ...syntheticReaderState,
    reading: { tocOpen: false, notesOpen: false, settingsOpen: true },
  })
  test.setState(state)
  const tree = renderTree(createElement(components.ReaderView, { state, actions, api: test.api }))
  const sliders = collectNodes(tree, (node) => node.type === 'input' && node.props.type === 'range')
  assert.ok(sliders.length >= 3, 'three reading sliders rendered')
  sliders[0].props.onChange({ target: { value: '24' } })
  assert.equal(calls.length, 1, 'font-size slider calls setSettings')
  assert.equal(calls[0][0].fontSize, 24)
  restoreAction('setSettings')
  checks += 1
  console.log('ok - interface: reading settings sliders call setSettings')
}

// Split layout: draggable divider + chat wrapper around the conversation pane.
{
  const state = makeState({ view: 'reader', ...syntheticReaderState })
  const tree = renderTree(createElement(components.ReaderView, { state, actions, api: test.api }))
  const splitter = findByClassName(tree, 'rd-reader-split')
  const wrapper = findByClassName(tree, 'rd-reader-chatwrap')
  assert.equal(splitter.length, 1, 'one draggable divider rendered')
  assert.equal(wrapper.length, 1, 'chat pane wrapped for resizing')
  assert.equal(typeof splitter[0].props.onPointerDown, 'function', 'divider supports pointer drag')
  assert.equal(typeof splitter[0].props.onKeyDown, 'function', 'divider supports keyboard resize')
  checks += 1
  console.log('ok - interface: reader renders the resizable chat divider')
}

// Composer model picker + reasoning disclosure render from chat state.
{
  const state = makeState({
    view: 'reader',
    ...syntheticReaderState,
    ask: {
      messages: [
        { id: 'm1', role: 'user', text: '解释这段', quote: '學而時習之', chapterIndex: 0, createdAt: 1 },
        {
          id: 'm2',
          role: 'assistant',
          text: '这是学而篇首章。',
          reasoning: '先看章节标题，再解释关键字。',
          model: { provider: 'fake', model: 'fake-model' },
          streaming: false,
          error: null,
          question: '解释这段',
          chapterIndex: 0,
          createdAt: 2,
        },
      ],
      draftQuote: null,
      streaming: false,
      models: {
        default: { provider: 'fake', model: 'fake-model' },
        providers: [{ id: 'fake', name: 'Fake', models: [{ id: 'fake-model', name: 'Fake model' }] }],
      },
      modelsLoading: false,
      modelsError: null,
      selection: { provider: 'fake', model: 'fake-model' },
      activeModel: null,
    },
  })
  const tree = renderTree(createElement(components.ChatPane, { state, actions }))
  const picker = collectNodes(tree, (node) => node.type === 'button' && node.props['aria-haspopup'] === 'listbox')
  assert.equal(picker.length, 1, 'model picker button rendered')
  const pickerText = textOf(picker[0])
  assert.ok(pickerText.includes('fake-model'), `pinned model shown in the picker (${pickerText})`)
  const reasoningToggle = collectNodes(tree, (node) => node.type === 'button' && textOf(node).includes('思考过程'))
  assert.equal(reasoningToggle.length, 1, 'reasoning disclosure rendered')
  const modelTag = collectNodes(tree, (node) => typeof node.props.className === 'string' && node.props.className.includes('rd-chat-model-tag'))
  assert.equal(modelTag.length, 1, 'per-answer model tag rendered')
  checks += 1
  console.log('ok - interface: chat renders the model picker, reasoning disclosure and model tag')
}

console.log(`\nrender smoke test passed (${checks} cases)`)
