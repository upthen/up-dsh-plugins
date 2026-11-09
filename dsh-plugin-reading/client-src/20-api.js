/**
 * Wire helpers: the authenticated unary RPC route, the byte/stream routes, and
 * the address helpers the reader uses for covers and inline images.
 *
 * URL forms are document-relative on purpose: the page may be mounted under a
 * prefix, and Connection's routes resolve against the document base.
 */

/** Build one coded error the views can branch on. */
function readingError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Resolve the plugin's own HTTP surface. */
function createReadingApi(ctx) {
  const documentBase = () => document.baseURI || `${location.origin}/`
  const absolute = (path) => new URL(path, documentBase()).href

  /**
   * Call one unary RPC endpoint and unwrap its result.
   *
   * This is a plain same-origin POST to the plugin's authenticated
   * `/api/reading/rpc` route: the browser cookie is sent automatically, and we
   * do not depend on Connection's dedicated per-channel RPC registry.
   */
  async function rpc(endpoint, payload, signal) {
    const url = absolute('api/reading/rpc')
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload: payload ?? {} }),
        signal,
      })
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      throw readingError('reading/transport-failed', error instanceof Error ? error.message : String(error))
    }
    const result = await response.json().catch(() => null)
    if (!result || result.ok !== true) {
      const failure = result && result.error ? result.error : {}
      throw readingError(failure.code || 'reading/rpc-failed', failure.message || tr('请求失败。', 'Request failed.'))
    }
    return result.value
  }

  const coverUrl = (bookId) => absolute(`api/reading/cover?id=${encodeURIComponent(bookId)}`)
  const assetUrl = (bookId, name) =>
    absolute(`api/reading/asset?book=${encodeURIComponent(bookId)}&name=${encodeURIComponent(name)}`)

  /** Upload one EPUB file's bytes and import it on the Host. */
  async function uploadEpub(file, signal) {
    const url = absolute(`api/reading/import?name=${encodeURIComponent(file.name || 'book.epub')}`)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        signal,
      })
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      throw readingError('reading/upload-failed', tr('上传失败：', 'Upload failed: ') + (error instanceof Error ? error.message : String(error)))
    }
    const data = await response.json().catch(() => null)
    if (!response.ok || !data || data.ok !== true) {
      const failure = data && data.error ? data.error : {}
      throw readingError(failure.code || 'reading/import-failed', failure.message || `HTTP ${response.status}`)
    }
    return data
  }

  /** Stream one model answer as server-sent events. */
  async function streamAsk(payload, options = {}) {
    const { signal, onDelta, onReasoning, onModel, onUsage, onError, onDone } = options
    const url = absolute('api/reading/ask')
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error) {
      if (error && error.name === 'AbortError') return
      throw readingError('reading/ask-failed', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok || !response.body) {
      throw readingError('reading/ask-failed', `HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let settled = false
    const handleFrame = (frame) => {
      const line = frame.split('\n').find((entry) => entry.startsWith('data:'))
      if (!line) return
      let data
      try {
        data = JSON.parse(line.slice(5).trim())
      } catch {
        return
      }
      if (typeof data.delta === 'string') onDelta?.(data.delta)
      else if (typeof data.reasoning === 'string') onReasoning?.(data.reasoning)
      else if (data.model && typeof data.model === 'object') onModel?.(data.model)
      else if (data.usage && typeof data.usage === 'object') onUsage?.(data.usage)
      else if (data.error) {
        settled = true
        onError?.(readingError(data.error.code || 'reading/ask-failed', data.error.message || '回答失败'))
      } else if (data.done === true) {
        settled = true
        onDone?.()
      }
    }
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          handleFrame(buffer.slice(0, index))
          buffer = buffer.slice(index + 2)
        }
      }
      if (!settled) onDone?.()
    } catch (error) {
      if (error && error.name === 'AbortError') return
      throw error
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // The stream may already be closed.
      }
    }
  }

  return { rpc, coverUrl, assetUrl, uploadEpub, streamAsk }
}
