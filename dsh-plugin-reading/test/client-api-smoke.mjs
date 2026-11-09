/**
 * Client wire smoke test.
 *
 * Exercises `client-src/20-api.js` exactly as the page does: the unary RPC POST,
 * the EPUB upload POST, and the SSE answer stream, with a mocked `fetch`. This is
 * the last seam between the React views and the Host routes; the render smoke test
 * and the Host route suite cover the two sides.
 *
 *   node test/client-api-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { createContext, runInContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'client-src')
const names = (await fs.readdir(srcDir)).filter((name) => name.endsWith('.js')).sort()
const parts = []
for (const name of names) parts.push(await fs.readFile(join(srcDir, name), 'utf8'))
const joined = parts.join('\n')
const marker = 'return readingPlugin'
const tail = `
globalThis.__READING_API_TEST__ = {
  get api() { return READING_API },
  get actions() { return READING_ACTIONS },
  get store() { return READING_STORE },
  setState: (state) => { __TEST_STATE__ = state },
}
`
let __unused = null
const source = `window.__ModuleLoader__.load({ id: '@local/dsh-reading', factory(require) {\n${joined.replace(
  marker,
  `let __TEST_STATE__ = null\nuseReading = () => __TEST_STATE__\n${tail}\n${marker}`,
)}\n} });`

let loaded = null
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props }),
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
const fakeSlots = { inject: (_key, callback) => () => callback?.()?.(), register: () => () => {} }
const fakeLocale = { register: () => () => {}, bind: () => (key) => key, getLocale: () => ({ locale: 'zh' }), subscribe: () => () => {} }
const workspaceCalls = []
const fakeCtx = {
  get(name) {
    if (name === 'locale') return fakeLocale
    if (name === 'connection') return { rpc: { call: async () => ({ ok: true, value: {} }) } }
    if (name === 'uiWorkspace') return { startSession: (workspaceId, options) => workspaceCalls.push([workspaceId, options]) }
    return undefined
  },
  effect: (callback) => callback(),
  slots: fakeSlots,
  provide: () => {},
  on: () => () => {},
}

// fetch mock: each test installs the next responder
let nextFetch = null
const calls = []
async function mockFetch(url, init) {
  calls.push({ url, init })
  if (!nextFetch) throw new Error('unexpected fetch')
  return nextFetch(url, init)
}

const sandbox = {
  window: {
    __ModuleLoader__: { load: (definition) => { loaded = definition } },
    addEventListener() {},
    removeEventListener() {},
  },
  document: {
    baseURI: 'http://127.0.0.1:55385/',
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, style: {}, remove() {}, appendChild() {}, click() {} }),
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  },
  location: { origin: 'http://127.0.0.1:55385' },
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  TextDecoder,
  TextEncoder,
  URL,
  Request,
  Response,
  Headers,
  ReadableStream,
  Blob: class {},
  AbortController,
  fetch: mockFetch,
  navigator: { clipboard: { writeText: async () => {} } },
}
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(source, sandbox, { filename: 'client.api.test.js' })
assert.ok(loaded, 'test bundle loads')
const plugin = loaded.factory((request) => {
  if (request === 'react') return fakeReact
  throw new Error(`unexpected module request: ${request}`)
})
plugin.apply(fakeCtx)
const api = sandbox.__READING_API_TEST__?.api
assert.ok(api && typeof api.rpc === 'function', 'api exposed')

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

let checks = 0
const ok = (name) => {
  checks += 1
  console.log(`ok - ${name}`)
}

// ---- unary RPC ----
calls.length = 0
nextFetch = async () => jsonResponse({ ok: true, value: { books: [{ id: 'b1' }] } })
const shelf = await api.rpc('shelf', {})
assert.equal(calls.length, 1)
assert.equal(calls[0].url, 'http://127.0.0.1:55385/api/reading/rpc', 'RPC URL is document-relative and resolved')
assert.equal(calls[0].init.method, 'POST')
assert.deepEqual(JSON.parse(calls[0].init.body), { endpoint: 'shelf', payload: {} })
assert.deepEqual(shelf, { books: [{ id: 'b1' }] })
ok('rpc posts {endpoint,payload} and unwraps the value')

nextFetch = async () => jsonResponse({ ok: false, error: { code: 'reading/book-not-found', message: '找不到书' } })
await assert.rejects(api.rpc('book/open', { id: 'nope' }), (error) => error.code === 'reading/book-not-found' && error.message === '找不到书')
ok('rpc surfaces a coded host failure')

nextFetch = async () => new Response('not json', { status: 500 })
await assert.rejects(api.rpc('shelf', {}), (error) => error.code === 'reading/rpc-failed')
ok('rpc refuses a non-JSON failure response')

nextFetch = async () => {
  throw new TypeError('Failed to fetch')
}
await assert.rejects(api.rpc('shelf', {}), (error) => error.code === 'reading/transport-failed')
ok('rpc reports transport failures')

// ---- asset/cover addresses ----
assert.equal(api.coverUrl('b 1'), 'http://127.0.0.1:55385/api/reading/cover?id=b%201')
assert.equal(
  api.assetUrl('b1', 'x y.png'),
  'http://127.0.0.1:55385/api/reading/asset?book=b1&name=x%20y.png',
)
ok('cover and asset URLs are encoded and resolved against the document base')

// ---- EPUB upload ----
calls.length = 0
const file = { name: '論語.epub', size: 12 }
nextFetch = async () => jsonResponse({ ok: true, book: { id: 'b2', title: '論語', chapterCount: 22 } })
const imported = await api.uploadEpub(file)
assert.equal(calls[0].url, `http://127.0.0.1:55385/api/reading/import?name=${encodeURIComponent('論語.epub')}`)
assert.equal(calls[0].init.method, 'POST')
assert.equal(calls[0].init.headers['content-type'], 'application/octet-stream')
assert.equal(calls[0].init.body, file)
assert.equal(imported.book.id, 'b2')
ok('uploadEpub posts the file bytes to the import route')

nextFetch = async () => jsonResponse({ ok: false, error: { code: 'reading/too-large', message: '文件超过上限' } }, 400)
await assert.rejects(api.uploadEpub(file), (error) => error.code === 'reading/too-large')
ok('uploadEpub surfaces a rejected import')

// ---- SSE answer stream ----
function sseResponse(frames, chunkSize = 7) {
  const encoder = new TextEncoder()
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < payload.length; index += chunkSize) {
          controller.enqueue(encoder.encode(payload.slice(index, index + chunkSize)))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

calls.length = 0
let streamed = ''
let completed = false
let streamError = null
nextFetch = async () => sseResponse([{ delta: '學而' }, { delta: '時習之' }, { done: true }])
await api.streamAsk(
  { id: 'b1', chapterIndex: 0, quote: '學而時習之', question: '如何理解？' },
  {
    onDelta: (delta) => { streamed += delta },
    onDone: () => { completed = true },
    onError: (error) => { streamError = error },
  },
)
assert.equal(calls[0].url, 'http://127.0.0.1:55385/api/reading/ask')
assert.deepEqual(JSON.parse(calls[0].init.body).question, '如何理解？')
assert.equal(streamed, '學而時習之')
assert.equal(completed, true)
assert.equal(streamError, null)
ok('streamAsk parses SSE deltas split across arbitrary chunks')

let errorFrame = null
nextFetch = async () => sseResponse([{ delta: '部分' }, { error: { code: 'reading/ask-failed', message: '模型请求失败' } }])
await api.streamAsk(
  { id: 'b1', chapterIndex: 0 },
  { onDelta: () => {}, onDone: () => {}, onError: (error) => { errorFrame = error } },
)
assert.ok(errorFrame && errorFrame.code === 'reading/ask-failed')
ok('streamAsk surfaces an SSE error frame')

nextFetch = async () => new Response('nope', { status: 503 })
await assert.rejects(api.streamAsk({ id: 'b1' }, { onDelta: () => {} }), (error) => error.code === 'reading/ask-failed')
ok('streamAsk refuses a failed status')

// ---- store actions over the mocked wire: open a book and jump chapters ----
const live = sandbox.__READING_API_TEST__
const actions = live.actions
const store = live.store
assert.ok(actions && store, 'store and actions exposed')

const catalogue = {
  shelf: {
    ok: true,
    value: {
      books: [{ id: 'b1', title: '論語', author: '孔子', chapterCount: 3, cover: true, progress: { chapterIndex: 0, scrollRatio: 0, percent: 0 }, bookmarks: [] }],
      settings: { fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', theme: 'paper', contentWidth: 720 },
      notesCount: 0,
    },
  },
  'book/open': {
    ok: true,
    value: {
      book: { id: 'b1', title: '論語', author: '孔子', chapterCount: 3, cover: true, progress: { chapterIndex: 0, scrollRatio: 0, percent: 0 }, bookmarks: [] },
      toc: [{ index: 0, title: '學而第一' }, { index: 1, title: '為政第二' }, { index: 2, title: '八佾第三' }],
      chapterIndex: 0,
      notes: [],
    },
  },
  'book/open-mark': { ok: true, value: { book: { id: 'b1' } } },
  'book/progress': { ok: true, value: { progress: { chapterIndex: 0, scrollRatio: 0, percent: 0 } } },
  'book/chapter': {
    ok: true,
    value: {
      chapterIndex: 0,
      chapterCount: 3,
      chapter: { title: '學而第一', blocks: [{ t: 'p', runs: [{ text: '學而時習之' }] }] },
      bookmarks: [],
    },
  },
}
let currentChapterRequested = -1
nextFetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : {}
  const endpoint = body.endpoint
  if (endpoint === 'book/chapter') {
    currentChapterRequested = body.payload.chapterIndex
    return jsonResponse({
      ok: true,
      value: {
        ...catalogue['book/chapter'].value,
        chapterIndex: body.payload.chapterIndex,
        chapter: { title: `第${body.payload.chapterIndex + 1}章`, blocks: [{ t: 'p', runs: [{ text: `chapter-${body.payload.chapterIndex}` }] }] },
      },
    })
  }
  const entry = catalogue[endpoint]
  return jsonResponse(entry || { ok: false, error: { code: 'reading/unknown-endpoint', message: endpoint } })
}

await actions.bootstrap()
assert.equal(store.get().status, 'ready')
assert.equal(store.get().shelf.books.length, 1)
ok('store: bootstrap loads the shelf over the mocked wire')

await actions.openBook('b1')
assert.equal(store.get().view, 'reader')
assert.equal(store.get().current.chapterIndex, 0)
assert.equal(store.get().current.toc.length, 3)
ok('store: openBook loads the book and first chapter')

await actions.loadChapter(2)
assert.equal(currentChapterRequested, 2, 'book/chapter asked for the requested index')
assert.equal(store.get().current.chapterIndex, 2, 'current chapter advanced')
assert.equal(store.get().current.chapter.title, '第3章')
assert.equal(store.get().loadingBook, false)
ok('store: loadChapter jumps to the requested chapter')

await actions.loadChapter(0)
assert.equal(store.get().current.chapterIndex, 0)
assert.equal(currentChapterRequested, 0)
ok('store: loadChapter jumps backwards too')

// ---- reader chat: one passage question becomes a streamed chat turn ----
let askRequestPayload = null
nextFetch = async (url, init) => {
  assert.ok(String(url).includes('/api/reading/ask'), 'ask hits the SSE route')
  askRequestPayload = JSON.parse(init.body)
  return sseResponse([
    { model: { provider: 'fake', model: 'fake-model' } },
    { reasoning: '先想' },
    { reasoning: '一想' },
    { delta: '「說」通「悅」，' },
    { delta: '喜意也。' },
    { done: true },
  ])
}
await actions.askWithQuote('「說」字怎么解？', { quote: '學而時習之，不亦說乎？', chapterIndex: 0 })
assert.equal(askRequestPayload.quote, '學而時習之，不亦說乎？')
assert.equal(askRequestPayload.question, '「說」字怎么解？')
let chat = store.get().ask
assert.equal(chat.messages.length, 2, 'user + assistant turns')
assert.equal(chat.messages[0].role, 'user')
assert.equal(chat.messages[0].quote, '學而時習之，不亦說乎？')
assert.equal(chat.messages[1].role, 'assistant')
assert.equal(chat.messages[1].text, '「說」通「悅」，喜意也。')
assert.equal(chat.messages[1].reasoning, '先想一想', 'reasoning deltas are collected')
assert.equal(chat.messages[1].model.provider, 'fake', 'model frame provider recorded')
assert.equal(chat.messages[1].model.model, 'fake-model', 'model frame id recorded')
assert.equal(chat.streaming, false)
ok('store: askWithQuote streams text + reasoning + model into the transcript')

// ---- parked quote: beginQuestion, then askWithQuote uses it automatically ----
actions.beginQuestion('學而時習之，不亦說乎？', 0)
assert.equal(store.get().ask.draftQuote.text, '學而時習之，不亦說乎？')
nextFetch = async (url, init) => {
  askRequestPayload = JSON.parse(init.body)
  return sseResponse([{ delta: '答案二' }, { done: true }])
}
await actions.askWithQuote('这句话的背景是什么？')
assert.equal(store.get().ask.draftQuote, null, 'parked quote consumed')
assert.equal(askRequestPayload.quote, '學而時習之，不亦說乎？', 'parked quote carried into the request')
chat = store.get().ask
assert.equal(chat.messages.length, 4, 'two turns appended')
const assistantId = chat.messages[3].id
ok('store: beginQuestion parks a quote and askWithQuote consumes it')

// ---- save one chat answer as a note ----
let savedNotePayload = null
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  assert.equal(body.endpoint, 'note/save')
  savedNotePayload = body.payload.note
  return jsonResponse({
    ok: true,
    value: { note: { id: 'n1', ...body.payload.note }, notes: [{ id: 'n1', ...body.payload.note }] },
  })
}
const saved = await actions.saveMessageNote(assistantId)
assert.ok(saved && saved.id === 'n1', 'note returned')
assert.equal(savedNotePayload.bookId, 'b1')
assert.equal(savedNotePayload.quote, '學而時習之，不亦說乎？')
assert.equal(savedNotePayload.question, '这句话的背景是什么？')
assert.equal(savedNotePayload.answer, '答案二')
assert.equal(store.get().notes.length, 1, 'notes list updated')
ok('store: saveMessageNote posts the chat answer to note/save and updates notes')

// ---- continue one chat answer in a normal conversation ----
workspaceCalls.length = 0
let conversationPromptPayload = null
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  assert.equal(body.endpoint, 'conversation/prompt')
  conversationPromptPayload = body.payload
  return jsonResponse({ ok: true, value: { prompt: 'PROMPT_TEXT' } })
}
await actions.bringMessageToConversation(assistantId)
assert.equal(conversationPromptPayload.quote, '學而時習之，不亦說乎？')
assert.equal(conversationPromptPayload.question, '这句话的背景是什么？')
assert.equal(workspaceCalls.length, 1, 'startSession called once')
assert.equal(workspaceCalls[0][0], undefined, 'no workspaceId (current workspace default)')
assert.equal(workspaceCalls[0][1].prompt, 'PROMPT_TEXT', 'composed prompt handed to the composer')
assert.equal(workspaceCalls[0][1].whenDraftExists, 'append', 'existing drafts are preserved')
ok('store: bringMessageToConversation opens a new session with the composed draft')

// ---- clear chat ----
actions.clearChat()
assert.equal(store.get().ask.messages.length, 0)
ok('store: clearChat empties the transcript')

// ---- model picker: directory cache + pinned route on the next question ----
let modelsRequested = 0
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  assert.equal(body.endpoint, 'ask/models')
  modelsRequested += 1
  return jsonResponse({
    ok: true,
    value: {
      models: {
        default: { provider: 'p', model: 'm1' },
        providers: [
          {
            id: 'p',
            name: 'Provider P',
            models: [
              { id: 'm1', name: 'M1', description: '' },
              { id: 'm2', name: 'M2', description: '' },
            ],
          },
        ],
      },
    },
  })
}
const models = await actions.loadAskModels()
assert.equal(modelsRequested, 1)
assert.equal(models.providers[0].models.length, 2)
await actions.loadAskModels()
assert.equal(modelsRequested, 1, 'model directory is cached')
actions.setAskModel({ provider: 'p', model: 'm2', reasoningEffort: 'high' })
assert.equal(store.get().ask.selection.model, 'm2')
nextFetch = async (url, init) => {
  askRequestPayload = JSON.parse(init.body)
  return sseResponse([{ delta: 'x' }, { done: true }])
}
await actions.askWithQuote('切换模型后的提问')
assert.equal(askRequestPayload.provider, 'p', 'pinned provider sent')
assert.equal(askRequestPayload.model, 'm2', 'pinned model sent')
assert.equal(askRequestPayload.reasoningEffort, 'high', 'pinned reasoning effort sent')
actions.setAskModel(null)
assert.equal(store.get().ask.selection, null, 'back to default')

// A selection that is not in the provider directory is kept, never silently reset.
actions.setAskModel({ provider: 'p', model: 'custom-not-listed' })
await actions.loadAskModels()
assert.equal(store.get().ask.selection.model, 'custom-not-listed', 'selection survives a partial model directory')
actions.setAskModel(null)
ok('store: model directory loads, caches, and the pinned model rides the next question')

// ---- reading progress: scroll reporting persists through the debounced save ----
const progressPayloads = []
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (body.endpoint === 'book/progress') {
    progressPayloads.push(body.payload)
    return jsonResponse({ ok: true, value: { progress: { ...body.payload, updatedAt: Date.now() } } })
  }
  return jsonResponse({ ok: true, value: {} })
}
actions.reportScroll(0.42)
await new Promise((resolve) => setTimeout(resolve, 1400))
assert.equal(progressPayloads.length, 1, 'one debounced progress write')
assert.equal(progressPayloads[0].chapterIndex, 0)
assert.ok(Math.abs(progressPayloads[0].scrollRatio - 0.42) < 1e-9)
assert.ok(Math.abs(store.get().progress.scrollRatio - 0.42) < 1e-9)
ok('store: reportScroll updates progress and persists it (debounced)')

// ---- bookmarks ----
let bookmarkRequested = null
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (body.endpoint === 'book/bookmark/add') {
    bookmarkRequested = body.payload
    return jsonResponse({ ok: true, value: { bookmarks: [{ id: 'bm1', chapterIndex: 0, scrollRatio: 0.42, quote: '學而時習之' }] } })
  }
  if (body.endpoint === 'book/bookmark/remove') {
    return jsonResponse({ ok: true, value: { bookmarks: [] } })
  }
  return jsonResponse({ ok: true, value: {} })
}
await actions.toggleBookmark()
assert.equal(bookmarkRequested.chapterIndex, 0)
assert.ok(Math.abs(bookmarkRequested.scrollRatio - 0.42) < 1e-9)
assert.equal(store.get().current.bookmarks.length, 1, 'bookmark stored in state')
await actions.removeBookmark('bm1')
assert.equal(store.get().current.bookmarks.length, 0, 'bookmark removed from state')
ok('store: toggleBookmark adds and removeBookmark removes, at the current position')

// ---- reading settings persist through the host ----
let settingsPayload = null
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  assert.equal(body.endpoint, 'settings/save')
  settingsPayload = body.payload.settings
  return jsonResponse({ ok: true, value: { settings: { ...store.get().shelf.settings, ...body.payload.settings } } })
}
await actions.setSettings({ fontSize: 22, theme: 'app' })
assert.deepEqual(settingsPayload, { fontSize: 22, theme: 'app' })
assert.equal(store.get().shelf.settings.fontSize, 22)
ok('store: setSettings applies optimistically and saves to the host')

// ---- the notes page loads the whole notebook and filters by book locally ----
let noteListPayload = null
nextFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  assert.equal(body.endpoint, 'note/list')
  noteListPayload = body.payload
  return jsonResponse({
    ok: true,
    value: {
      notes: [
        { id: 'n1', bookId: 'b1', bookTitle: '論語', chapterIndex: 0, chapterTitle: '學而第一', quote: '學而時習之', question: '', answer: '', note: '', tags: [] },
        { id: 'n2', bookId: 'b2', bookTitle: '唐诗三百首', chapterIndex: 0, chapterTitle: '卷一', quote: '床前明月光', question: '', answer: '', note: '', tags: [] },
      ],
    },
  })
}
await actions.loadNotes()
assert.equal(noteListPayload.bookId, undefined, 'note/list is not scoped to the open book')
assert.equal(store.get().notes.length, 2, 'all notes are available to the notes page')
ok('store: loadNotes loads the whole notebook (book filter stays client-side)')

console.log(`\nclient wire smoke test passed (${checks} checks)`)
