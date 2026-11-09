/**
 * HTTP routes for the reading UI (raw bytes and streaming answers).
 *
 * These live under Connection's authenticated `/api` prefix, so only the local
 * owner browser reaches them; the browser's signed cookie travels with a
 * same-origin `fetch()` and no token handling is needed on either side.
 */
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { createRpcHandler, failure } from './rpc.js'

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorResponse(error, fallbackCode) {
  return json(
    {
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : fallbackCode,
        message: error instanceof Error ? error.message : String(error),
      },
    },
    400,
  )
}

/** Register every reading route; returns one disposer for all of them. */
export function attachRoutes(ctx, library, ask, config) {
  const disposers = []
  const register = (route) => {
    try {
      disposers.push(ctx.connection.fetch.register(route))
    } catch (error) {
      console.error('[reading] failed to register route', route.path, error)
    }
  }

  // Unary RPC. Connection's dedicated-channel API (`connection.rpc.handle`) is
  // not usable from a bundle in this runtime: it resolves `owner.webServer` on
  // a context that never injected webServer, so it throws and — from a promise
  // continuation — kills the host. An exact Fetch route gives the same
  // authenticated, owner-only surface without that lookup.
  const handleRpc = createRpcHandler(library, { ask })
  register({
    path: '/api/reading/rpc',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return errorResponse(failure('reading/bad-request', '请求体必须是 JSON'), 'reading/bad-request')
      }
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : ''
      if (!endpoint) {
        return errorResponse(failure('reading/bad-request', '缺少 endpoint 字段'), 'reading/bad-request')
      }
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}
      return json(await handleRpc(endpoint, payload, request.signal))
    },
  })

  register({
    path: '/api/reading/import',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const name = url.searchParams.get('name') || 'book.epub'
      try {
        await library.ensure()
        const buffer = new Uint8Array(await request.arrayBuffer())
        if (buffer.byteLength === 0) throw Object.assign(new Error('空文件'), { code: 'reading/empty-file' })
        const maxBytes = Number(config?.maxImportBytes) || 200 * 1024 * 1024
        if (buffer.byteLength > maxBytes) {
          throw Object.assign(new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`), { code: 'reading/too-large' })
        }
        const result = await library.importEpub(buffer, name)
        return json({ ok: true, book: result.book, warnings: result.warnings })
      } catch (error) {
        return errorResponse(error, 'reading/import-failed')
      }
    },
  })

  register({
    path: '/api/reading/cover',
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      try {
        await library.ensure()
        const id = url.searchParams.get('id') || ''
        const book = library.findBook(id)
        const dir = library.bookDir(id)
        const entries = await fs.readdir(dir)
        const coverName = entries.find((entry) => entry.startsWith('cover.'))
        if (!coverName) return new Response('not found', { status: 404 })
        const bytes = await fs.readFile(join(dir, coverName))
        return new Response(bytes, {
          headers: {
            'content-type': book.coverType || 'image/jpeg',
            'cache-control': 'private, max-age=3600',
          },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    },
  })

  register({
    path: '/api/reading/asset',
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      try {
        await library.ensure()
        const id = url.searchParams.get('book') || ''
        const name = basename(url.searchParams.get('name') || '')
        if (!name || name.includes('..')) return new Response('bad request', { status: 400 })
        library.findBook(id)
        const bytes = await fs.readFile(join(library.bookDir(id), 'assets', name))
        return new Response(bytes, {
          headers: { 'content-type': mediaTypeFor(name), 'cache-control': 'private, max-age=86400' },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    },
  })

  register({
    path: '/api/reading/ask',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
        await library.ensure()
      } catch (error) {
        return errorResponse(error, 'reading/bad-request')
      }
      const abort = new AbortController()
      const onAbort = () => abort.abort()
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (value) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
          try {
            for await (const frame of ask.streamAsk(body, abort.signal)) {
              if (!frame || typeof frame !== 'object') continue
              if (frame.kind === 'text') send({ delta: frame.text })
              else if (frame.kind === 'reasoning') send({ reasoning: frame.text })
              else if (frame.kind === 'model') send({ model: { provider: frame.provider, model: frame.model } })
              else if (frame.kind === 'usage') send({ usage: frame.usage })
            }
            send({ done: true })
          } catch (error) {
            send({
              error: {
                code: typeof error?.code === 'string' ? error.code : 'reading/ask-failed',
                message: error instanceof Error ? error.message : String(error),
              },
            })
          } finally {
            request.signal?.removeEventListener('abort', onAbort)
            try {
              controller.close()
            } catch {
              // The browser may already have closed the stream.
            }
          }
        },
        cancel() {
          abort.abort()
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    },
  })

  return () => {
    for (const dispose of disposers) {
      // Never leave a rejected disposer promise unhandled: an unhandled
      // rejection in the host process exits DSH (see index.js).
      try {
        Promise.resolve(dispose()).catch((error) => {
          console.error('[reading] route dispose failed', error)
        })
      } catch (error) {
        console.error('[reading] route dispose threw', error)
      }
    }
  }
}

function mediaTypeFor(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}
