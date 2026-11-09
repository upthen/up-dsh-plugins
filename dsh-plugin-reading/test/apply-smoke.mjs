/**
 * Apply-level smoke test for the Host half.
 *
 *   node test/apply-smoke.mjs
 *
 * The fake Context deliberately makes \`connection.rpc\` throw the exact error
 * the real DSH host raises (\`cannot get property "webServer" without inject\`).
 * Any code path that still registers an RPC channel through
 * \`ctx.connection.rpc.handle()\` therefore fails here instead of crashing the
 * whole DSH host process with an unhandled rejection.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'

const unhandled = []
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason)
})

const plugin = await import('../index.js')

const root = await fs.mkdtemp(join(tmpdir(), 'reading-apply-'))
const routes = new Map()
const effects = []
let toolRegistrations = 0

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
  inject(services, callback) {
    if (!services.includes('tools')) return
    callback({
      effect(fn, label) {
        const dispose = fn()
        effects.push({ label, dispose })
        return dispose
      },
      tools: {
        register() {
          toolRegistrations += 1
          return () => {}
        },
      },
    })
  },
  get() {
    return undefined
  },
  connection: {
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    // Mirrors the shadowed lookups cordis performs inside HostConnectionService.
    get rpc() {
      throw new Error('cannot get property "webServer" without inject')
    },
  },
}

plugin.apply(ctx, { libraryDir: join(root, 'library') })
await new Promise((resolve) => setTimeout(resolve, 150))

assert.deepEqual(
  unhandled.map((reason) => String(reason && reason.message ? reason.message : reason)),
  [],
  'apply() must not produce unhandled rejections (the DSH host exits on them)',
)

for (const path of ['/api/reading/rpc', '/api/reading/import', '/api/reading/cover', '/api/reading/asset', '/api/reading/ask']) {
  assert.ok(routes.has(path), 'route ' + path + ' registered')
}

const rpcRoute = routes.get('/api/reading/rpc')
const call = async (body) => {
  const response = await rpcRoute.fetch(
    new Request('http://localhost/api/reading/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

const shelf = await call({ endpoint: 'shelf', payload: {} })
assert.equal(shelf.status, 200)
assert.equal(shelf.body.ok, true)
assert.deepEqual(shelf.body.value.books, [])

const unknown = await call({ endpoint: 'does/not/exist', payload: {} })
assert.equal(unknown.status, 200)
assert.equal(unknown.body.ok, false)
assert.equal(unknown.body.error.code, 'reading/unknown-endpoint')

const malformed = await call({})
assert.equal(malformed.status, 400)
assert.equal(malformed.body.ok, false)

for (const effect of effects) {
  if (typeof effect.dispose === 'function') await effect.dispose()
}
await fs.rm(root, { recursive: true, force: true })
assert.ok(toolRegistrations >= 1, 'tools registered through the tools inject scope')
console.log('ok - apply() registers the authenticated RPC route without touching connection.rpc')
console.log('ok - RPC route dispatches shelf / unknown endpoint / malformed body')
console.log('ok - ' + effects.length + ' effects and ' + toolRegistrations + ' tools registered')