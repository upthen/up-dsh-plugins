/**
 * Host route integration test.
 *
 * Exercises the exact Fetch routes the browser half calls - `/api/reading/rpc`,
 * `/api/reading/import`, `/api/reading/cover`, `/api/reading/asset`,
 * `/api/reading/ask` - through `attachRoutes`, with a fake Connection registry and
 * a fake LLM service. This is the seam the reader UI depends on and the part the
 * browser cannot test from Node.
 *
 *   node test/routes-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { Library } from '../host/store.js'
import { attachRoutes } from '../host/routes.js'
import { createAskService } from '../host/ask.js'
import { createRpcHandler } from '../host/rpc.js'

const here = dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (name) => {
  checks += 1
  console.log(`ok - ${name}`)
}

const root = await fs.mkdtemp(join(tmpdir(), 'reading-routes-'))
const library = new Library(join(root, 'library'))
await library.ensure()

// ---- fake host context: capture the Fetch routes and the tools ----
const routes = new Map()
const fakeCtx = {
  get(name) {
    if (name === 'llm') {
      return {
        listProviders() {
          return [{ id: 'fake', name: 'Fake provider' }]
        },
        async listModels(provider) {
          assert.equal(provider, 'fake')
          return [
            { id: 'fake-model', name: 'Fake model', description: '' },
            { id: 'fake-model-2', name: 'Fake model 2', description: '' },
          ]
        },
        stream(options) {
          return (async function* generate() {
            yield { type: 'model', provider: options.provider, model: options.model }
            yield { type: 'reasoning-delta', index: 0, text: '先想' }
            yield { type: 'reasoning-delta', index: 0, text: '一想' }
            for (const text of ['「學而時習之」', '：学是效法，', '习是反复实践。']) {
              yield { type: 'text-delta', index: 0, text }
            }
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    return dispose
  },
  inject(_deps, callback) {
    callback(fakeCtx)
  },
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  },
}

const ask = createAskService(fakeCtx, library, { ask: { contextChars: 1200, maxTokens: 256 } })
const disposeRoutes = attachRoutes(fakeCtx, library, ask, {})
assert.deepEqual(
  [...routes.keys()].sort(),
  ['/api/reading/ask', '/api/reading/asset', '/api/reading/cover', '/api/reading/import', '/api/reading/rpc'],
  'all five routes registered',
)
ok('attachRoutes registers the five browser-facing routes')

// ---- import route ----
const epub = await fs.readFile(join(here, 'sample-lunyu.epub'))
const importResponse = await routes.get('/api/reading/import').fetch(
  new Request('http://local/api/reading/import?name=sample.epub', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: epub,
  }),
)
const importBody = await importResponse.json()
assert.equal(importResponse.status, 200)
assert.equal(importBody.ok, true, 'import route reports ok')
assert.ok(importBody.book.id, 'import route returns a book id')
const bookId = importBody.book.id
ok(`import route stores the EPUB (${importBody.book.chapterCount} chapters)`)

// ---- unary RPC route ----
async function rpc(endpoint, payload) {
  const response = await routes.get('/api/reading/rpc').fetch(
    new Request('http://local/api/reading/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    }),
  )
  return { status: response.status, body: await response.json() }
}

const shelf = await rpc('shelf', {})
assert.equal(shelf.body.ok, true)
assert.equal(shelf.body.value.books.length, 1)
ok('rpc route: shelf lists the imported book')

const chapter = await rpc('book/chapter', { id: bookId, chapterIndex: 0 })
assert.equal(chapter.body.ok, true)
assert.ok(chapter.body.value.chapter.blocks.length > 0)
ok('rpc route: book/chapter returns blocks')

const progress = await rpc('book/progress', { id: bookId, chapterIndex: 1, scrollRatio: 0.5, percent: 0.6 })
assert.equal(progress.body.ok, true)
assert.equal(progress.body.value.progress.chapterIndex, 1)
ok('rpc route: book/progress persists')

const bookmark = await rpc('book/bookmark/add', { id: bookId, chapterIndex: 0, quote: '學而時習之', chapterTitle: '学而篇第一' })
assert.equal(bookmark.body.ok, true)
assert.equal(bookmark.body.value.bookmarks.length, 1)
ok('rpc route: bookmark add')

const note = await rpc('note/save', {
  note: { bookId, bookTitle: '論語', chapterIndex: 0, chapterTitle: '学而篇第一', quote: '學而時習之', question: '怎么理解？', answer: '学习并实践。' },
})
assert.equal(note.body.ok, true)
assert.equal(note.body.value.note.id.startsWith('n_'), true)
ok('rpc route: note save')

const notes = await rpc('note/list', { bookId })
assert.equal(notes.body.value.notes.length, 1)
ok('rpc route: note list')

const search = await rpc('search', { q: '為政以德' })
assert.equal(search.body.ok, true)
assert.ok(search.body.value.results.length >= 1)
ok('rpc route: search finds chapter text')

const prompt = await rpc('conversation/prompt', { id: bookId, chapterIndex: 0, quote: '學而時習之', question: '如何理解？' })
assert.equal(prompt.body.ok, true)
assert.ok(prompt.body.value.prompt.includes('學而時習之'))
ok('rpc route: conversation/prompt composes the handoff')

const badEndpoint = await rpc('nope/nope', {})
assert.equal(badEndpoint.body.ok, false)
assert.equal(badEndpoint.body.error.code, 'reading/unknown-endpoint')
ok('rpc route: unknown endpoint returns a coded failure')

const malformed = await routes.get('/api/reading/rpc').fetch(
  new Request('http://local/api/reading/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
)
const malformedBody = await malformed.json()
assert.equal(malformedBody.ok, false)
assert.equal(malformedBody.error.code, 'reading/bad-request')
ok('rpc route: malformed body returns bad-request')

// ---- cover route ----
const covers = await fs.readdir(join(library.bookDir(bookId)))
const hasCover = covers.some((name) => name.startsWith('cover.'))
if (hasCover) {
  const coverResponse = await routes.get('/api/reading/cover').fetch(new Request(`http://local/api/reading/cover?id=${bookId}`))
  assert.equal(coverResponse.status, 200)
  assert.ok((await coverResponse.arrayBuffer()).byteLength > 0)
  ok('cover route serves cover bytes')
} else {
  const coverResponse = await routes.get('/api/reading/cover').fetch(new Request(`http://local/api/reading/cover?id=${bookId}`))
  assert.equal(coverResponse.status, 404)
  ok('cover route reports 404 when the book has no cover')
}

// ---- asset route ----
const content = await library.readContent(bookId)
const imageBlock = content.chapters.flatMap((entry) => entry.blocks).find((block) => block.t === 'img')
if (imageBlock) {
  const assetResponse = await routes.get('/api/reading/asset').fetch(
    new Request(`http://local/api/reading/asset?book=${bookId}&name=${encodeURIComponent(imageBlock.src)}`),
  )
  assert.equal(assetResponse.status, 200)
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0)
  ok('asset route serves the inline image')
} else {
  ok('asset route: sample book has no inline image (skipped)')
}

// ---- ask route: server-sent events ----
const askResponse = await routes.get('/api/reading/ask').fetch(
  new Request('http://local/api/reading/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: bookId, chapterIndex: 0, quote: '學而時習之', question: '这句话怎么理解？' }),
  }),
)
assert.equal(askResponse.status, 200)
assert.equal(askResponse.headers.get('content-type')?.startsWith('text/event-stream'), true)
const raw = await askResponse.text()
assert.ok(raw.includes('data:'), 'SSE frames emitted')
assert.ok(raw.includes('"delta"'), 'SSE delta frames present')
assert.ok(raw.includes('"done":true'), 'SSE completion frame present')
const frames = raw
  .split('\n\n')
  .map((frame) => frame.replace(/^data:\s*/, ''))
  .filter(Boolean)
  .map((json) => JSON.parse(json))
const deltas = frames.filter((frame) => typeof frame.delta === 'string')
assert.equal(deltas.map((frame) => frame.delta).join(''), '「學而時習之」：学是效法，习是反复实践。')
const reasoning = frames.filter((frame) => typeof frame.reasoning === 'string').map((frame) => frame.reasoning).join('')
assert.equal(reasoning, '先想一想', 'reasoning frames forwarded')
assert.ok(
  frames.some((frame) => frame.model && frame.model.model === 'fake-model'),
  'model frame forwarded',
)
assert.ok(frames.some((frame) => frame.usage), 'usage frame forwarded')
ok('ask route streams text, reasoning, model and usage frames plus done')

// ---- a pinned model rides the request and is echoed back ----
const pinnedResponse = await routes.get('/api/reading/ask').fetch(
  new Request('http://local/api/reading/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: bookId, chapterIndex: 0, provider: 'fake', model: 'fake-model-2' }),
  }),
)
const pinnedRaw = await pinnedResponse.text()
assert.ok(pinnedRaw.includes('"fake-model-2"'), 'pinned model echoed in the model frame')
assert.ok(pinnedRaw.includes('"delta"'), 'pinned model still streams an answer')
ok('ask route honors a pinned provider/model')

// ---- ask/models: provider + model directory for the composer picker ----
const rpcWithAsk = createRpcHandler(library, { ask })
const modelsResult = await rpcWithAsk('ask/models', {}, new AbortController().signal)
assert.equal(modelsResult.ok, true)
assert.equal(modelsResult.value.models.providers[0].id, 'fake')
assert.equal(modelsResult.value.models.providers[0].models.length, 2)
assert.equal(modelsResult.value.models.default.model, 'fake-model')
ok('rpc route: ask/models lists providers and their models')

const rpcWithoutAsk = createRpcHandler(library, {})
const noAskResult = await rpcWithoutAsk('ask/models', {}, new AbortController().signal)
assert.equal(noAskResult.ok, false)
assert.equal(noAskResult.error.code, 'reading/no-ask')
ok('rpc route: ask/models fails cleanly without an ask service')

// ---- ask route with an unavailable model ----
const noModelCtx = {
  ...fakeCtx,
  get: (name) =>
    name === 'llm'
      ? { stream: () => (async function* () {})() }
      : name === 'agentDefaultModel'
        ? { currentSelection: () => undefined }
        : undefined,
}
const noModelAsk = createAskService(noModelCtx, library, {})
// Re-register the routes so the ask route closes over the no-model service.
const disposeNoModel = attachRoutes(noModelCtx, library, noModelAsk, {})
const noModelResponse = await routes.get('/api/reading/ask').fetch(
  new Request('http://local/api/reading/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: bookId, chapterIndex: 0, quote: 'x', question: 'y' }),
  }),
)
const noModelRaw = await noModelResponse.text()
assert.ok(noModelRaw.includes('reading/model-unavailable'), 'missing model is reported as a coded SSE error')
await disposeNoModel()
ok('ask route reports an unavailable default model instead of crashing')

// ---- disposer ----
await disposeRoutes()
assert.equal(routes.size, 0, 'routes disposed')
ok('route disposer removes every route without unhandled rejections')

await fs.rm(root, { recursive: true, force: true })
console.log(`\nroute integration smoke test passed (${checks} checks)`)
